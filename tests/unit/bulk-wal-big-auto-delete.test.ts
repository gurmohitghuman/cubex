// Webhook auto-delete's slices sized by bytes (services/webhook-auto-delete-rows.ts finishedRows, HEAVY_SLICE_BYTES):
// rows holding a 100 KB answer each, which went 500 to a slice before (each row deleted and its pages zeroed, and
// with a copy written again in the other sheet: past the WAL's 64 MB in one commit). Each sweep is measured
// (bulk-wal-kit.ts: every checkpoint on the worker held 300 ms, the event loop never held 200 ms, the WAL under
// journal_size_limit) and no slice writes much past HEAVY_SLICE_BYTES: deleting alone, and copying first. The
// newest keep_rows rows stay, every other row goes, and a copied row arrives whole, in order. Small rows still go
// 500 a slice: webhook-auto-delete.test.ts K.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, tid, ok, done } = columnTrashKit('bulk-wal-big-auto-delete')
const { createSourceWithColumn } = await import('../../server/src/lib/webhook-service')
const { setSheetWebhookAutoDelete } = await import('../../server/src/services/sheet-webhook')
const { autoDeleteSweep } = await import('../../server/src/services/webhook-auto-delete-sweep')
const { HEAVY_SLICE_BYTES } = await import('../../server/src/lib/constants')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const MOST_FRAMES = Math.ceil((1.5 * HEAVY_SLICE_BYTES) / 4096)
const N = 600, KEEP = 100, CELL = 100_000
const sheet = (name: string, columns: string[]): string => {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, name, JSON.stringify(columns))
  return sid
}
// A webhook sheet of N rows the webhook added (its 📥 mark), each with a 100 KB Json cell.
function webhookSheet(name: string): string {
  const sid = sheet(name, ['Email', 'Json'])
  const raw = createSourceWithColumn(sid, uid, name).source.raw_column_name
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      ins.run(uuid(), sid, uid, i, JSON.stringify({ [raw]: '📥 12:00:00', Email: `u${i}@x.co`,
        Json: `${i}:${'j'.repeat(CELL)}` }))
    }
  }).immediate()
  return sid
}
const left = (sid: string) =>
  db.prepare('SELECT row_index FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid) as number[]
const sized = (r: { w: { mostTransactionFrames: number } }, what: string) =>
  assert.ok(r.w.mostTransactionFrames <= MOST_FRAMES, `${what}: a slice wrote ${r.w.mostTransactionFrames} frames`)
let clock = Date.now()
// Sweeps until only the newest KEEP rows are left (10 slices a sweep).
async function sweepAll(sid: string) {
  for (let i = 0; i < 20 && left(sid).length > KEEP; i++) { clock += 10_000; await autoDeleteSweep(clock) }
}
const newest = Array.from({ length: KEEP }, (_, i) => N - KEEP + i)

await ok('auto-delete deleting alone: slices sized by bytes, the newest rows kept', async () => {
  const sid = webhookSheet('Leads')
  assert.ok('ok' in setSheetWebhookAutoDelete(uid, sid, { keep_rows: KEEP }))
  sized(await measure('auto-delete', () => sweepAll(sid)), 'deleting')
  assert.deepEqual(left(sid), newest)
})

await ok('auto-delete copying first: slices sized by bytes, every row copied whole and in order', async () => {
  const sid = webhookSheet('Leads copied')
  const archive = sheet('Archive', [])
  assert.ok('ok' in setSheetWebhookAutoDelete(uid, sid, { keep_rows: KEEP, copy_to_sheet_id: archive }))
  sized(await measure('auto-delete with a copy', () => sweepAll(sid)), 'copying')
  assert.deepEqual(left(sid), newest)
  const copied = db.prepare(`SELECT json_extract(data, '$.Json') FROM rows WHERE sheet_id = ? ORDER BY row_index`)
    .pluck().all(archive) as string[]
  assert.equal(copied.length, N - KEEP)
  assert.ok(copied.every((c, i) => c.startsWith(`${i}:`) && c.length === `${i}:`.length + CELL), 'copied whole')
})

await closeWalCheckpointer()
done()
