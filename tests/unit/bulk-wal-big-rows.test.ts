// Slices sized by bytes (lib/slice-bytes.ts, HEAVY_SLICE_BYTES): rows holding a 16 KB answer each, which went 5,000
// to a slice before (about 20,000 frames, 80 MB of WAL in one commit, the server held up to 244 ms). Each job is
// measured (bulk-wal-kit.ts: every checkpoint on the worker held 300 ms, the event loop never held 200 ms, the WAL
// under journal_size_limit) and no slice writes much past HEAVY_SLICE_BYTES: a run's ⏳ seeded and cleared, a
// column's key copied (a rename) and stripped (a delete), an import taken out again; every cell ends where it
// should. withinBytes's edges first. The trash and duplicate removal: bulk-wal-big-trash.test.ts.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, ok, done, sheet, cells } = undoKit('bulk-wal-big-rows')
const { seedProcessingPlaceholders, clearProcessingPlaceholders, PLACEHOLDER } =
  await import('../../server/src/lib/placeholder-cells')
const { copyColumnKey, purgeColumnKey, recordPurge } = await import('../../server/src/lib/column-purge')
const { undoImport } = await import('../../server/src/lib/import-undo')
const { withinBytes } = await import('../../server/src/lib/slice-bytes')
const { HEAVY_SLICE_BYTES } = await import('../../server/src/lib/constants')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

// A slice's pages, about one per 4 KB of its rows, and some room for its journal and index pages.
const MOST_FRAMES = Math.ceil((1.5 * HEAVY_SLICE_BYTES) / 4096)
const N = 3_000, CELL = 16_000
const big = () => sheet(Array.from({ length: N }, (_, i) => ({ Name: `n${i}`, Status: `s${i}`, Answer: `a${i}`,
  Json: `${i}:${'j'.repeat(CELL)}` })), ['Name', 'Status', 'Answer', 'Json'])
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()
const ends = (sid: string, column: string) => [cells(sid, column)[0], cells(sid, column)[N - 1]]
const sized = (r: { w: { mostTransactionFrames: number } }, what: string) =>
  assert.ok(r.w.mostTransactionFrames <= MOST_FRAMES, `${what}: a slice wrote ${r.w.mostTransactionFrames} frames`)

await ok('withinBytes: as many as fit, at least one, nulls count nothing', () => {
  assert.equal(withinBytes([], 10), 0)
  assert.equal(withinBytes([4, 4, 4], 10), 2)
  assert.equal(withinBytes([4, 6, 1], 10), 2, 'exactly the budget fits')
  assert.equal(withinBytes([50, 1], 10), 1, 'a row past the budget goes alone')
  assert.equal(withinBytes([null, null, 3], 3), 3)
})

await ok('a run seeded, then cleared: slices sized by bytes, the WAL copied back on the worker', async () => {
  const sid = big()
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Status')`).run(id, sid, uid)
  const r = { kind: 'http' as const, id }
  sized(await measure('the seed', () => seedProcessingPlaceholders({ run: r, sheetId: sid, userId: uid,
    columns: ['Status', 'Answer'], targets: null, lastRow: N - 1, live: () => true }), { pastAuto: true }), 'seed')
  assert.equal(held.get(sid, PLACEHOLDER), N, 'every row seeded')
  sized(await measure('the clear', () => clearProcessingPlaceholders(sid, uid, ['Status', 'Answer'], undefined, r),
    { pastAuto: true }), 'clear')
  assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
  assert.deepEqual([...ends(sid, 'Status'), ...ends(sid, 'Answer')], ['s0', `s${N - 1}`, 'a0', `a${N - 1}`])
})

await ok('a column\'s key copied, then stripped: slices sized by bytes', async () => {
  const sid = big()
  sized(await measure('the key copied', () => copyColumnKey(sid, uid, 'Answer', 'Reply'), { pastAuto: true }), 'copy')
  assert.deepEqual(ends(sid, 'Reply'), ['a0', `a${N - 1}`])
  recordPurge(sid, uid, 'Answer')
  sized(await measure('the key stripped', () => purgeColumnKey(sid, uid, 'Answer'), { pastAuto: true }), 'strip')
  assert.equal(db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND json_type(data, '$.Answer') IS NOT NULL`)
    .pluck().get(sid), 0)
  assert.equal(ends(sid, 'Json')[1].length, String(N - 1).length + 1 + CELL, 'the big cells kept')
})

await ok('an import taken out again: slices sized by bytes', async () => {
  const sid = sheet([{ Name: 'kept' }], ['Name'])
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 1; i <= N; i++) ins.run(uuid(), sid, uid, i, JSON.stringify({ Name: `in${i}`, J: 'j'.repeat(CELL) }))
  }).immediate()
  const job = { sheet_id: sid, user_id: uid, is_replace: 0, first_row: 1, end_row: N + 1, columns: '["Name"]' }
  db.prepare(`INSERT INTO import_jobs (sheet_id,user_id,is_replace,first_row,end_row,columns)
    VALUES (?,?,0,?,?,?)`).run(sid, uid, job.first_row, job.end_row, job.columns)
  sized(await measure('the import taken out', () => undoImport(job), { pastAuto: true }), 'import undo')
  assert.deepEqual(cells(sid, 'Name'), ['kept'])
})

await closeWalCheckpointer()
done()
