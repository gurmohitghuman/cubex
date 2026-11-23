// More background bulk writers, each measured (bulk-wal-kit.ts): a sheet's values copied into a new sheet
// (services/sheet-copy-job.ts, small rows and rows of about 1,500 characters, each slice printed), auto-run's
// queue dropped and rows kept by id past an import or a restore
// (lib/autorun-mark.ts), and a duplicate removal's plan saved (lib/dedupe/journal.ts). Rows with random ids, each
// checkpoint on the worker held 300 ms: the event loop is never held 200 ms, no checkpoint's sync runs on the API
// thread, the WAL stays under journal_size_limit, SQLite's own checkpoint is back on afterwards, and every row,
// queued row and fence ends where it should.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
import { transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, sheet, cells } = undoKit('bulk-wal-jobs')
const { copySheetValues } = await import('../../server/src/services/sheet-copy')
const { autorunDropPending, autorunSkipImport, autorunSkipRestore } = await import('../../server/src/lib/autorun-mark')
const { saveDedupePlan, dropDedupeJob } = await import('../../server/src/lib/dedupe/journal')
const { DEDUPE_DELETE_CHUNK_ROWS } = await import('../../server/src/lib/constants-dedupe')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const N = 20_000
const big = () => sheet(Array.from({ length: N }, (_, i) => ({ Name: `n${i}`, P: `${i}:${'p'.repeat(200)}` })),
  ['Name', 'Status', 'P'])
// `k` auto-run entries on `sid` (HTTP ones, status columns `${tag}0`…), fenced at `fence`.
const entries = (sid: string, k: number, fence: number, tag = 'S') => Array.from({ length: k }, (_, j) => {
  const id = uuid()
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index)
    VALUES (?,?,?,?,'http','["Name"]',?)`).run(id, uid, sid, `${tag}${j}`, fence)
  return id
})
const queued = db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?').pluck()
const fenceOf = db.prepare('SELECT watermark_row_index FROM autorun_columns WHERE id = ?').pluck()

// A copy of `sid` measured, each of its transactions printed (a slice is one): its `n` rows all in, in order.
async function copyMeasured(label: string, sid: string, n: number) {
  let out: Awaited<ReturnType<typeof copySheetValues>> | null = null
  const m = await measure(label, async () => { out = await copySheetValues(uid, sid, { name: label }) },
    { pastAuto: true })
  for (const r of m.records) console.log(`        ${transactionLine(r)}`)
  assert.ok(out && 'ok' in out && out.ok.rowsCopied === n, JSON.stringify(out))
  const copy = (out as { ok: { sheet: { id: string } } }).ok.sheet.id
  assert.deepEqual([cells(copy, 'Name')[0], cells(copy, 'Name')[n - 1]], ['n0', `n${n - 1}`])
}

await ok('a sheet\'s values copied: the WAL copied back on the worker', () => copyMeasured('the copy', big(), N))

await ok('a sheet\'s wide values copied (about 1,500 characters a row): the WAL copied back on the worker', () =>
  copyMeasured('the wide copy', sheet(Array.from({ length: 6_000 }, (_, i) => ({ Name: `n${i}`,
    P: `${i}:${'p'.repeat(1_500)}` })), ['Name', 'Status', 'P']), 6_000))

await ok('auto-run\'s queue dropped: the WAL copied back on the worker', async () => {
  const sid = big()
  const ids = entries(sid, 5, N - 1)
  const fill = db.prepare(`INSERT INTO autorun_pending (autorun_id,user_id,row_id)
    SELECT ?, user_id, id FROM rows WHERE sheet_id = ?`)
  db.transaction(() => { for (const id of ids) fill.run(id, sid) }).immediate()
  await measure('the queue dropped', () => autorunDropPending(sid, uid), { pastAuto: true })
  assert.deepEqual(ids.map(id => queued.get(id)), ids.map(() => 0))
})

await ok('rows kept by id past an import, then past a restore: the WAL copied back on the worker', async () => {
  const sid = big()
  const ids = entries(sid, 3, -1)
  // An import of rows N … N + 999 with auto-run paused for it: rows 0 … N - 1 are still new to each entry.
  await measure('kept past an import', () => autorunSkipImport(sid, uid, N, N + 999), { pastAuto: true })
  assert.deepEqual(ids.map(id => [queued.get(id), fenceOf.get(id)]), ids.map(() => [N, N + 999]))
  const later = entries(sid, 4, N / 2, 'T')
  // Rows coming back at or below N - 1: rows N / 2 + 1 … N - 1 are kept for the entries fenced at N / 2.
  await measure('kept past a restore', () => autorunSkipRestore(sid, uid, N - 1), { pastAuto: true })
  assert.deepEqual(later.map(id => [queued.get(id), fenceOf.get(id)]), later.map(() => [N / 2 - 1, N - 1]))
})

await ok('a duplicate removal\'s plan saved: the WAL copied back on the worker', async () => {
  const sid = sheet([{ Name: 'x' }], ['Name'])
  const rowIds = Float64Array.from({ length: 1_500_000 }, (_, i) => i * 3 + 1)
  await measure('the plan saved', () => saveDedupePlan(sid, uid, 1, rowIds), { pastAuto: true })
  const chunks = db.prepare('SELECT COUNT(*) FROM dedupe_chunks WHERE sheet_id = ?').pluck().get(sid)
  assert.equal(chunks, Math.ceil(rowIds.length / DEDUPE_DELETE_CHUNK_ROWS))
  assert.equal(db.prepare('SELECT stage FROM dedupe_jobs WHERE sheet_id = ?').pluck().get(sid), 'deleting')
  dropDedupeJob(sid)
})

await closeWalCheckpointer()
done()
