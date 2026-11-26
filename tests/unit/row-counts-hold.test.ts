// The home's wait for its row counts over HTTP (GET /api/tables/row-counts, routes/tables.ts): an account holds at
// most MAX_COUNT_WAITS_PER_USER of them, a 429 past that, and a page that leaves lets go of its slot at once, as the
// sheet's change poll does. So leaving and opening the home again while its counts are made never meets the 429.
// The count is held after its first slice (lib/row-counts.ts setRowCountSlices), so the waits stay open.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { signToken } = await import('../../server/src/lib/auth')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')
const { setRowCountSlices } = await import('../../server/src/lib/row-counts')
const { ROW_COUNT_SLICE_ROWS } = await import('../../server/src/lib/constants-row-counts')
const { MAX_COUNT_WAITS_PER_USER, countWaitsOf } = await import('../../server/src/lib/long-poll-holds')
const { createTable } = await import('../../server/src/services/table-crud')
const { addSheetColumn } = await import('../../server/src/services/column-add')
const { appendRows } = await import('../../server/src/services/rows-write')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
runMigrations()

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const t = createTable(uid, 'Leads')
if (!('ok' in t)) throw new Error(JSON.stringify(t))
addSheetColumn(t.ok.sheetId, uid, 'Name', { seedEmptyRow: false })
assert.ok('ok' in appendRows(t.ok.sheetId, uid, Array.from({ length: 10 }, (_, i) => ({ Name: `r${i}` }))))

const app = express()
applyServerMiddleware(app, { isProduction: false })
app.use('/api/tables', (await import('../../server/src/routes/tables')).default)
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tables`
const headers = { Cookie: `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}` }

async function until(what: string, test: () => boolean): Promise<void> {
  const t0 = Date.now()
  while (!test()) {
    if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
// One page's wait: its answer, and how it leaves.
function wait() {
  const page = new AbortController()
  const answer = fetch(`${base}/row-counts`, { headers, signal: page.signal })
  answer.catch(() => { /* the page left */ })
  return { page, answer }
}

let failures = 0
let letGo = () => {}
try {
  // The count held after its first slice (10 rows, slices of 2) until let go.
  const held = new Promise<void>(r => { letGo = r })
  setRowCountSlices(2, () => held)
  const list = await (await fetch(base, { headers })).json() as Array<{ id: string; row_count_updating: boolean }>
  assert.equal(list.find(x => x.id === t.ok.id)?.row_count_updating, true, 'the table is being counted')

  const first = Array.from({ length: MAX_COUNT_WAITS_PER_USER }, wait)
  await until('the waits held', () => countWaitsOf(uid) === MAX_COUNT_WAITS_PER_USER)
  assert.equal((await fetch(`${base}/row-counts`, { headers })).status, 429, 'one more than the account may hold')

  for (const w of first) w.page.abort()
  await until('the slots let go once the pages left', () => countWaitsOf(uid) === 0)

  const again = Array.from({ length: MAX_COUNT_WAITS_PER_USER }, wait)
  await until('the waits of the pages opened again held', () => countWaitsOf(uid) === MAX_COUNT_WAITS_PER_USER)
  letGo()
  for (const w of again) {
    const res = await w.answer
    assert.equal(res.status, 200)
    const { tables } = await res.json() as { tables: Array<{ id: string }> }
    assert.deepEqual(tables.find(x => x.id === t.ok.id),
      { id: t.ok.id, row_count: 10, row_count_updating: false })
  }
  assert.equal(countWaitsOf(uid), 0, 'each slot let go once answered')
  console.log('ok   a page that leaves lets go of its wait at once; opened again, its waits are held, not refused')
} catch (e) {
  failures++
  console.log('FAIL a page that leaves lets go of its wait at once\n ', (e as Error).stack)
} finally {
  letGo()
  setRowCountSlices(ROW_COUNT_SLICE_ROWS, null)
  server.close()
  await closeWalCheckpointer()
}
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
passed()
