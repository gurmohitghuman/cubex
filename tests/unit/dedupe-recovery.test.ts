// Removing duplicates against a real database (services/dedupe-*.ts,
// lib/dedupe/journal.ts, migration 026). Pins: a check changes nothing and
// agrees with the removal; the first row of each key stays, empty keys and run
// statuses stay; removed rows take their AI/HTTP results with them; the fence
// moves once and auto-run follows it; rows appended during a removal stay; a
// run on the sheet refuses it; a removal cut short by a restart comes out the
// same after resumeDuplicateRemovals, and never deletes a row added since.
// Over 200 lines: one fixture and the removal's scenarios, read top to bottom.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import checkMod from '../../server/src/services/dedupe-check'
import removeMod from '../../server/src/services/dedupe-remove'
import scanMod from '../../server/src/services/dedupe-scan'
import journalMod from '../../server/src/lib/dedupe/journal'
import busyMod from '../../server/src/lib/sheet-busy'
import rowsMod from '../../server/src/services/rows-write'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { checkDuplicates } = checkMod as typeof import('../../server/src/services/dedupe-check')
const { removeDuplicates, resumeDuplicateRemovals } =
  removeMod as typeof import('../../server/src/services/dedupe-remove')
const { scanDuplicates } = scanMod as typeof import('../../server/src/services/dedupe-scan')
const J = journalMod as typeof import('../../server/src/lib/dedupe/journal')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { appendRows } = rowsMod as typeof import('../../server/src/services/rows-write')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const tick = () => new Promise(r => setImmediate(r))
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
let seed = 7
const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }

// n rows at positions 0, 2, 4… (deletes leave gaps, so positions aren't 0…n-1):
// emails from a pool written with random case and spaces, some empty, some a
// run's status; an AI and an HTTP run with results on some rows.
function fixture(n: number, pool: number) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, '["Email","Name"]')
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  const ai = uuid(), http = uuid()
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const p = rand(pool)
      const email = i % 17 === 0 ? '' : i % 19 === 0 ? '⏭️ Not found'
        : `${rand(2) ? ' ' : ''}${rand(2) ? 'USER' : 'user'}${p}@acme.com${rand(2) ? '  ' : ''}`
      ins.run(uuid(), sid, uid, i * 2, JSON.stringify({ Email: email, Name: `N${i}` }))
    }
    db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status)
      VALUES (?,?,?,'o','p','completed')`).run(ai, sid, uid)
    db.prepare("INSERT INTO http_runs (id,sheet_id,user_id,config,status) VALUES (?,?,?,'{}','completed')")
      .run(http, sid, uid)
    for (let i = 0; i < n; i += 3) {
      db.prepare('INSERT INTO ai_results (id,run_id,user_id,row_index) VALUES (?,?,?,?)').run(uuid(), ai, uid, i * 2)
    }
    for (let i = 0; i < n; i += 5) {
      db.prepare('INSERT INTO http_results (id,run_id,user_id,row_index) VALUES (?,?,?,?)')
        .run(uuid(), http, uid, i * 2)
    }
  })()
  return sid
}

const rowsOf = (sid: string) => db.prepare(`SELECT id, row_index, json_extract(data, '$.Email') AS email FROM rows
  WHERE sheet_id = ? ORDER BY row_index`).all(sid) as Array<{ id: string; row_index: number; email: string }>
const normal = (e: string) => (e.trim() === '' || e.startsWith('⏭️') ? null : e.trim().toLowerCase())
// The row ids that stay with "keep first", worked out the plain way.
function expectedKept(sid: string): Set<string> {
  const seen = new Set<string>(), kept = new Set<string>()
  for (const r of rowsOf(sid)) {
    const k = normal(r.email)
    if (k === null || !seen.has(k)) kept.add(r.id)
    if (k !== null) seen.add(k)
  }
  return kept
}
const sheetRow = (sid: string) => db.prepare('SELECT row_generation AS g, data_version AS v FROM sheets WHERE id = ?')
  .get(sid) as { g: number; v: number }
const resultsOrphaned = (sid: string) => (db.prepare(`
  SELECT (SELECT COUNT(*) FROM ai_results res WHERE res.run_id IN (SELECT id FROM ai_runs WHERE sheet_id = ?)
      AND NOT EXISTS (SELECT 1 FROM rows r WHERE r.sheet_id = ? AND r.row_index = res.row_index))
    + (SELECT COUNT(*) FROM http_results res WHERE res.run_id IN (SELECT id FROM http_runs WHERE sheet_id = ?)
      AND NOT EXISTS (SELECT 1 FROM rows r WHERE r.sheet_id = ? AND r.row_index = res.row_index)) AS c
`).get(sid, sid, sid, sid) as { c: number }).c
const BY_EMAIL = { columns: [{ column: 'Email', match: 'email' }] }

await ok('check changes nothing; removal keeps the first of each, results follow, fence moves once', async () => {
  const sid = fixture(9_000, 3_000)
  const kept = expectedKept(sid)
  const before = sheetRow(sid), total = rowsOf(sid).length
  const watch = uuid()
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, input_columns,
    watermark_row_index, row_generation_seen) VALUES (?,?,?,?,?,?,?,?)`)
    .run(watch, uid, sid, 'Name', 'http', '["Email"]', 1_000_000, before.g)
  const check = await checkDuplicates(uid, sid, BY_EMAIL)
  assert.ok('ok' in check)
  assert.equal(check.ok.duplicateRows, total - kept.size)
  assert.equal(check.ok.rowsChecked, total)
  assert.equal(check.ok.blockedBy, null)
  assert.ok(check.ok.samples.length > 0 && check.ok.samples[0].kept.row < check.ok.samples[0].removed[0].row)
  assert.equal(rowsOf(sid).length, total, 'a check deletes nothing')
  assert.deepEqual(sheetRow(sid), before)

  const out = await removeDuplicates(uid, sid, BY_EMAIL)
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(out.ok.removed, total - kept.size)
  assert.equal(out.ok.rowsLeft, kept.size)
  assert.deepEqual(new Set(rowsOf(sid).map(r => r.id)), kept, 'the first row of each email stays')
  assert.equal(resultsOrphaned(sid), 0, 'removed rows took their results')
  assert.ok((db.prepare('SELECT COUNT(*) AS c FROM ai_results').get() as { c: number }).c > 0)
  const after = sheetRow(sid)
  assert.equal(after.g, before.g + 1, 'row_generation moved once')
  assert.ok(after.v > before.v, 'data_version moved')
  const a = db.prepare(`SELECT watermark_row_index AS w, row_generation_seen AS g, rescan
    FROM autorun_columns WHERE id = ?`).get(watch) as { w: number; g: number; rescan: number }
  assert.equal(a.g, after.g, 'auto-run took the new generation')
  assert.equal(a.w, Math.max(...rowsOf(sid).map(r => r.row_index)), 'auto-run fence follows the last row down')
  assert.equal(a.rescan, 1)
  assert.equal(J.dedupeJobs().length, 0, 'journal dropped')
  const again = await removeDuplicates(uid, sid, BY_EMAIL)
  assert.ok('ok' in again && again.ok.removed === 0, 'a second removal finds nothing')
  assert.equal(sheetRow(sid).g, after.g, 'nothing removed: the fence stays')
})

await ok('most complete: run statuses count as empty; the higher row wins a tie', async () => {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `M_${sid.slice(0, 8)}`, '["Email","Name","Note"]')
  const rows = [
    { Email: 'x@a.com', Name: '', Note: '⏳ Processing...' }, // fills 1
    { Email: 'X@A.com', Name: 'Bo', Note: ' ' }, // fills 2
    { Email: 'x@a.com', Name: 'Cy', Note: '❌ failed' }, // fills 2: a tie, the higher row stays
    { Email: 'y@a.com', Name: 'Di', Note: 'n', Gone: 'not a column' }, // the stray key doesn't count
    { Email: 'y@a.com', Name: 'Ed', Note: 'n' },
  ]
  rows.forEach((d, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(`m${i}-${sid}`, sid, uid, i, JSON.stringify(d)))
  const out = await removeDuplicates(uid, sid, { ...BY_EMAIL, keep: 'most_complete' })
  assert.ok('ok' in out)
  assert.deepEqual(rowsOf(sid).map(r => r.id), [`m1-${sid}`, `m3-${sid}`])
})

await ok('a run on the sheet refuses the removal; the check says so up front', async () => {
  const sid = fixture(200, 50)
  const run = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status)
    VALUES (?,?,?,'Name','p','paused')`).run(run, sid, uid)
  const out = await removeDuplicates(uid, sid, BY_EMAIL)
  assert.ok('fail' in out && out.fail === 'conflict' && out.blockingRun?.id === run, JSON.stringify(out))
  assert.equal(rowsOf(sid).length, 200)
  const check = await checkDuplicates(uid, sid, BY_EMAIL)
  assert.ok('ok' in check && check.ok.blockedBy?.run.id === run)
})

await ok('rows appended during a removal stay; a second removal meanwhile is busy', async () => {
  const sid = fixture(12_000, 4_000)
  const kept = expectedKept(sid)
  const first = removeDuplicates(uid, sid, BY_EMAIL)
  while (!sheetBusyWith(sid)) await tick()
  const second = await removeDuplicates(uid, sid, BY_EMAIL)
  assert.ok('fail' in second && second.busy, 'busy')
  const appended = appendRows(sid, uid, [{ Email: 'user1@acme.com', Name: 'late' }])
  assert.ok('ok' in appended)
  const out = await first
  assert.ok('ok' in out)
  const ids = new Set(rowsOf(sid).map(r => r.id))
  assert.ok(ids.has(appended.ok.rows[0].id), 'the appended duplicate stays')
  assert.equal(ids.size, kept.size + 1)
})

// Journal a removal of `sid` as the service would, then cut it short.
async function journaled(sid: string) {
  const floor = (db.prepare('SELECT MAX(row_index) AS m FROM rows WHERE sheet_id = ?').get(sid) as { m: number }).m + 1
  const found = (await scanDuplicates(sid, uid, { keys: [{ column: 'Email', match: 'email' }], keep: 'first' },
    { below: floor }))!
  await J.saveDedupePlan(sid, uid, floor, found.remove)
  return { floor, found }
}

await ok('resume: a removal still planning is dropped, nothing deleted', async () => {
  const sid = fixture(3_000, 1_000)
  const total = rowsOf(sid).length, g = sheetRow(sid).g
  await journaled(sid)
  db.prepare("UPDATE dedupe_jobs SET stage = 'planning' WHERE sheet_id = ?").run(sid)
  resumeDuplicateRemovals()
  assert.ok(sheetBusyWith(sid), 'busy from the first tick')
  await idle(sid)
  assert.equal(rowsOf(sid).length, total)
  assert.equal(sheetRow(sid).g, g)
  assert.equal(J.dedupeJobs().length, 0)
})

await ok('resume: half-way through deleting; a row added since under a planned rowid stays', async () => {
  const sid = fixture(20_000, 6_000)
  const kept = expectedKept(sid)
  const g = sheetRow(sid).g
  const { floor, found } = await journaled(sid)
  assert.ok(found.remove.length > 5_000, 'more than one chunk')
  // The first chunk, deleted as the service does (rows, results, its record).
  const first = J.nextDedupeChunk(sid)!
  db.transaction(() => {
    db.prepare('DELETE FROM rows WHERE rowid IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(Array.from(first.rowIds)))
    J.dropDedupeChunk(sid, first.chunk)
  })()
  // A planned row of a later chunk moved above the floor, as a row appended
  // since that got a deleted row's rowid would sit.
  const lateRowid = found.remove[found.remove.length - 1]
  db.prepare('UPDATE rows SET row_index = ? WHERE rowid = ?').run(floor + 5, lateRowid)
  const late = db.prepare('SELECT id FROM rows WHERE rowid = ?').get(lateRowid) as { id: string }
  resumeDuplicateRemovals()
  assert.ok(sheetBusyWith(sid))
  await idle(sid)
  const ids = new Set(rowsOf(sid).map(r => r.id))
  assert.ok(ids.has(late.id), 'a row at or above the floor is never deleted')
  assert.equal(ids.size, kept.size + 1)
  for (const id of kept) assert.ok(ids.has(id))
  assert.equal(sheetRow(sid).g, g + 1, 'the fence moved once')
  assert.equal(J.dedupeJobs().length, 0)
})

await ok('checks: a newer one stops the older ones, and a removal is never left behind a check', async () => {
  const sid = fixture(30_000, 9_000)
  const a = checkDuplicates(uid, sid, BY_EMAIL)
  while (!sheetBusyWith(sid) && !(await Promise.race([a.then(() => true), tick().then(() => false)]))) { /* */ }
  // Two checks wait on the same older one; both wake, and only one may hold the sheet.
  const b = checkDuplicates(uid, sid, BY_EMAIL)
  const c = checkDuplicates(uid, sid, BY_EMAIL)
  const removal = removeDuplicates(uid, sid, BY_EMAIL)
  const [ra, rb, rc, rr] = await Promise.all([a, b, c, removal])
  assert.ok('ok' in rr, `the removal went through: ${JSON.stringify(rr)}`)
  for (const r of [ra, rb, rc]) assert.ok('ok' in r || r.fail === 'conflict')
})

await ok('a check whose asker left while waiting never starts its scan', async () => {
  const sid = fixture(30_000, 9_000)
  const older = checkDuplicates(uid, sid, BY_EMAIL)
  const asker = new AbortController()
  const newer = checkDuplicates(uid, sid, BY_EMAIL, asker.signal)
  asker.abort()
  const [, out] = await Promise.all([older, newer])
  assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
  // Nothing holds the sheet afterwards: a removal starts at once.
  const removal = await removeDuplicates(uid, sid, BY_EMAIL)
  assert.ok('ok' in removal)
})

await ok('bad input is refused before anything is read', async () => {
  const sid = fixture(10, 5)
  const fails = [
    {}, { columns: [] }, { columns: ['Nope'] }, { columns: ['Email', 'Email'] },
    { columns: [{ column: 'Email', match: 'fuzzy' }] }, { columns: ['Email'], keep: 'newest' },
    { columns: [{ column: 'Email', phone_country: 'US' }] }, { columns: [{ column: 'Email', extra: 1 }] },
  ]
  for (const args of fails) {
    const out = await checkDuplicates(uid, sid, args)
    assert.ok('fail' in out && out.fail === 'bad_request', JSON.stringify(args))
  }
  const missing = await removeDuplicates(uid, uuid(), BY_EMAIL)
  assert.ok('fail' in missing && missing.fail === 'not_found')
})

if (failures > 0) { console.error(`${failures} dedupe-recovery assertion(s) failed`); process.exit(1) }
console.log('All dedupe-recovery assertions passed.')
process.exit(0)
