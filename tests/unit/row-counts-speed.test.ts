// The home's list on 4 sheets of 120,000 rows, none counted yet (as after a restart) and then all known
// (services/table-row-counts.ts, lib/row-counts.ts): its request reads no row and answers within
// HOME_REQUEST_MAX_MS; the counts it starts hold the event loop under LOOP_MAX_MS on the CPU in any stretch (slices
// of ROW_COUNT_SLICE_ROWS rows; loop-watch.ts); and once they are made, the request answers them without counting
// again.
// GET /api/tables counted every sheet on the request before: 1.2 to 1.4 s on 10 sheets of 1M rows.
// Where a server makes the -wal file its full size at start (Windows), so does this, after the migrations, so the
// counts' writes to sheets.counted_rows don't grow it while the loop is watched.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { countsMade, forgetRowCounts } = await import('../../server/src/lib/row-counts')
const { liveSheets, homeCounts } = await import('../../server/src/services/table-row-counts')
const { createTable } = await import('../../server/src/services/table-crud')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
const { heldText, loopWatch } = await import('./loop-watch')
const { sizeWalLikeAServer } = await import('./sqlite-write-probe')
runMigrations()
sizeWalLikeAServer(db, process.env.DB_PATH!)

const SHEETS = 4
const ROWS = 120_000
// Measured on Linux: the request 0.2 to 0.4 ms either way; the longest hold while counting 10 to 13 ms. Bounds at
// 5x or more of that.
const HOME_REQUEST_MAX_MS = 50
const LOOP_MAX_MS = 100

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const t0 = performance.now()
for (let k = 0; k < SHEETS; k++) {
  const t = createTable(uid, `Big ${k}`)
  if (!('ok' in t)) throw new Error(JSON.stringify(t))
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
    INSERT INTO rows (id, sheet_id, user_id, row_index, data) SELECT lower(hex(randomblob(16))), ?, ?, i,
    '{"Name":"x"}' FROM n`).run(ROWS, t.ok.sheetId, uid)
}
console.log(`      ${SHEETS} sheets of ${ROWS.toLocaleString('en-US')} rows made in `
  + `${(performance.now() - t0).toFixed(0)} ms`)

function home(): { ms: number; rows: number; updating: boolean } {
  const read: string[] = []
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => { read.push(sql); return prepare(sql) }) as typeof db.prepare
  const t = performance.now()
  let counts
  try { counts = homeCounts(uid, liveSheets(uid)) } finally { db.prepare = prepare }
  const ms = performance.now() - t
  assert.deepEqual(read.filter(q => /\bFROM\s+rows\b/i.test(q)), [], 'statements reading rows on the request')
  const all = [...counts.values()]
  return { ms, rows: all.reduce((n, c) => n + c.row_count, 0), updating: all.some(c => c.row_count_updating) }
}

let failures = 0
try {
  forgetRowCounts()
  const watch = loopWatch(() => [])
  await watch.ready
  const first = home()
  const c0 = performance.now()
  await countsMade(liveSheets(uid).map(s => s.id), Date.now() + 60_000)
  const countMs = performance.now() - c0
  const watched = watch()
  const known = home()
  console.log(`      the request, none counted: ${first.ms.toFixed(1)} ms; the counts made in `
    + `${countMs.toFixed(0)} ms, `
    + `${heldText(watched)}; the request, all known: ${known.ms.toFixed(1)} ms`)
  assert.equal(first.updating, true)
  assert.deepEqual({ rows: known.rows, updating: known.updating }, { rows: SHEETS * ROWS, updating: false })
  assert.ok(first.ms < HOME_REQUEST_MAX_MS, `the request took ${first.ms.toFixed(0)} ms, none counted`)
  assert.ok(known.ms < HOME_REQUEST_MAX_MS, `the request took ${known.ms.toFixed(0)} ms, all known`)
  assert.ok(watched.cpuMs < LOOP_MAX_MS, `the counts held the event loop ${watched.cpuMs.toFixed(0)} ms on the CPU`)
  console.log('ok   the home reads no row; its counts never hold the loop long')
} catch (e) {
  failures++
  console.log('FAIL the home reads no row; its counts never hold the loop long\n ', (e as Error).stack)
}
await closeWalCheckpointer()
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
passed()
