// The home's Runs column over HTTP (routes/tables.ts, services/table-runs.ts): GET /api/tables gives each table its
// runs going now and paused, linked to its first sheet (by position) with one, and leaves them out for a table with
// none, a finished run, a setup-only run, a hidden working table's run and a test copy's (none of which wakes a
// wait either); its Updated is the latest change to it or its live sheets. The read walks the run
// tables' partial status indexes, never a whole table. GET /runs answers at once without since, holds while the runs
// are as `since` says and answers within about a second of a change; a page that leaves lets go of its slot, and past
// MAX_RUNS_WAITS_PER_USER an account gets a 429 with Retry-After.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { signToken } = await import('../../server/src/lib/auth')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')
const { MAX_RUNS_WAITS_PER_USER, runsWaitsOf } = await import('../../server/src/lib/long-poll-holds')
const { HOME_RUNS_SQL } = await import('../../server/src/services/table-runs')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
runMigrations()

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const table = (name: string, hidden = 0) => {
  const id = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name,hidden) VALUES (?,?,?,?)').run(id, uid, name, hidden)
  return id
}
const sheet = (tableId: string, position: number, testOf: string | null = null) => {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,test_of) VALUES (?,?,?,?,?,?)')
    .run(id, tableId, uid, `S${position}`, position, testOf)
  return id
}
const aiRun = (sheetId: string, status: string, setupOnly = 0) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,setup_only)
    VALUES (?,?,?,'Fit','p','m',?,?)`).run(id, sheetId, uid, status, setupOnly)
  return id
}
const httpRun = (sheetId: string, status: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,status,master_column_name) VALUES (?,?,?,?,'Data')`)
    .run(id, sheetId, uid, status)
  return id
}

const leads = table('Leads'), [leads1, leads2] = [sheet(leads, 0), sheet(leads, 1)]
const quiet = table('Quiet'), quiet1 = sheet(quiet, 0)
const hidden = table('Working', 1), hidden1 = sheet(hidden, 0)
const copy = sheet(leads, 2, leads1)
// Leads: a running HTTP run and a paused AI run on its second sheet; nothing on its first but finished runs.
const going = httpRun(leads2, 'running')
const paused = aiRun(leads2, 'paused')
aiRun(leads1, 'completed')
httpRun(leads1, 'failed')
// Quiet: a setup-only AI run (a setup kept as a version), never a run anyone waits for.
aiRun(quiet1, 'running', 1)
// Left out: a hidden working table's run and a test copy's.
aiRun(hidden1, 'running')
httpRun(copy, 'running')

const app = express()
applyServerMiddleware(app, { isProduction: false })
app.use('/api/tables', (await import('../../server/src/routes/tables')).default)
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tables`
const headers = { Cookie: `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}` }
type Runs = { id: string; running: number; paused: number; sheet_id: string }
type Answer = { key: string; tables: Runs[] }

async function until(what: string, test: () => boolean): Promise<void> {
  const t0 = Date.now()
  while (!test()) {
    if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

let failures = 0
async function check(label: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}

try {
  await check('GET /api/tables: a table\'s runs going now and paused, linked to its first sheet with one', async () => {
    const list = await (await fetch(base, { headers })).json() as Array<{ id: string; runs?: Runs }>
    assert.deepEqual(list.find(t => t.id === leads)?.runs, { id: leads, running: 1, paused: 1, sheet_id: leads2 })
    assert.equal('runs' in list.find(t => t.id === quiet)!, false, 'a setup-only run is no run anyone waits for')
    assert.equal(list.some(t => t.id === hidden), false)
  })

  await check('GET /api/tables: a table\'s Updated is when it or one of its sheets last changed, not a test copy',
    async () => {
      const at = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args)
      at("UPDATE tables SET updated_at = '2020-01-01 00:00:00' WHERE id IN (?, ?)", leads, quiet)
      at("UPDATE sheets SET updated_at = '2021-05-06 07:08:09' WHERE id = ?", leads1)
      at("UPDATE sheets SET updated_at = '2021-01-01 00:00:00' WHERE id IN (?, ?)", leads2, quiet1)
      at("UPDATE sheets SET updated_at = '2030-01-01 00:00:00' WHERE id = ?", copy)
      at("UPDATE tables SET updated_at = '2022-02-02 02:02:02' WHERE id = ?", quiet)
      const list = await (await fetch(base, { headers })).json() as Array<{ id: string; updated_at: string }>
      assert.equal(list.find(t => t.id === leads)?.updated_at, '2021-05-06 07:08:09', 'its latest sheet, not the copy')
      assert.equal(list.find(t => t.id === quiet)?.updated_at, '2022-02-02 02:02:02', 'renamed after its sheet changed')
    })

  await check('the read walks the partial status indexes, never a whole run table', () => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${HOME_RUNS_SQL}`).all(uid, uid) as Array<{ detail: string }>)
      .map(p => p.detail)
    assert.ok(plan.some(d => d.includes('idx_ai_runs_active')), plan.join(' | '))
    assert.ok(plan.some(d => d.includes('idx_http_runs_active')), plan.join(' | '))
    // A partial index holds only the runs going now and paused; a whole-table scan reads "SCAN ai_runs" alone.
    assert.ok(!plan.some(d => /^SCAN (ai_runs|http_runs)$/.test(d)), plan.join(' | '))
  })

  let key = ''
  await check('GET /runs without since answers at once: the same runs, and their key', async () => {
    const t0 = Date.now()
    const answer = await (await fetch(`${base}/runs`, { headers })).json() as Answer
    assert.ok(Date.now() - t0 < 1000, 'not held')
    assert.deepEqual(answer.tables, [{ id: leads, running: 1, paused: 1, sheet_id: leads2 }])
    assert.ok(answer.key)
    key = answer.key
  })

  await check('GET /runs?since holds while the runs stay as they were, and answers within a second of a change',
    async () => {
      let answered = false
      const wait = fetch(`${base}/runs?since=${encodeURIComponent(key)}`, { headers })
        .then(r => { answered = true; return r.json() as Promise<Answer> })
      await new Promise(r => setTimeout(r, 1500))
      assert.equal(answered, false, 'held: nothing changed')
      db.prepare("UPDATE ai_runs SET status = 'running' WHERE id = ?").run(paused)
      const t0 = Date.now()
      const changed = await wait
      assert.ok(Date.now() - t0 < 2000, `answered ${Date.now() - t0} ms after the change`)
      assert.deepEqual(changed.tables, [{ id: leads, running: 2, paused: 0, sheet_id: leads2 }])
      assert.notEqual(changed.key, key)
      db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(going)
      db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(paused)
      const done = await (await fetch(`${base}/runs?since=${encodeURIComponent(changed.key)}`, { headers }))
        .json() as Answer
      assert.deepEqual(done.tables, [], 'no table has runs: each one is left out')
    })

  await check('a run on a sheet the home doesn\'t list (a hidden table\'s, a test copy\'s): not in the key, no wake',
    async () => {
      const before = (await (await fetch(`${base}/runs`, { headers })).json() as Answer).key
      const page = new AbortController()
      let answered = false
      fetch(`${base}/runs?since=${encodeURIComponent(before)}`, { headers, signal: page.signal })
        .then(() => { answered = true }).catch(() => {})
      await until('the wait held', () => runsWaitsOf(uid) === 1)
      const extra = [aiRun(hidden1, 'running'), httpRun(copy, 'paused')]
      await new Promise(r => setTimeout(r, 1500))
      assert.equal(answered, false, 'held: nothing the home lists changed')
      assert.equal((await (await fetch(`${base}/runs`, { headers })).json() as Answer).key, before)
      page.abort()
      await until('its slot let go', () => runsWaitsOf(uid) === 0)
      db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(extra[0])
      db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(extra[1])
    })

  await check('a page that leaves lets go of its slot; past the account\'s waits, a 429 with Retry-After', async () => {
    const now = await (await fetch(`${base}/runs`, { headers })).json() as Answer
    const pages = Array.from({ length: MAX_RUNS_WAITS_PER_USER }, () => {
      const page = new AbortController()
      fetch(`${base}/runs?since=${encodeURIComponent(now.key)}`, { headers, signal: page.signal }).catch(() => {})
      return page
    })
    await until('the waits held', () => runsWaitsOf(uid) === MAX_RUNS_WAITS_PER_USER)
    const refused = await fetch(`${base}/runs`, { headers })
    assert.equal(refused.status, 429)
    assert.equal(refused.headers.get('retry-after'), '25')
    for (const p of pages) p.abort()
    await until('the slots let go once the pages left', () => runsWaitsOf(uid) === 0)
  })
} finally {
  server.closeAllConnections()
  server.close()
  closeWalCheckpointer()
}
if (failures) { console.error(`${failures} table-runs check(s) failed`); process.exit(1) }
console.log('All table-runs checks passed.')
process.exitCode = 0
