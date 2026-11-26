// Rows picked from a trash batch go back in slices sized by bytes (services/trash-restore.ts,
// lib/trash/restore-rows.ts, HEAVY_SLICE_BYTES), as a whole batch does: up to TRASH_RESTORE_PICK_MAX picks went back in
// one transaction before, so 500 rows of 100 KB wrote past the WAL's 64 MB in one commit. Measured (bulk-wal-kit.ts:
// every checkpoint on the worker held 300 ms, the event loop never held 200 ms, the WAL under journal_size_limit), no
// slice writes much past HEAVY_SLICE_BYTES; every picked row is back whole at its old place and the others stay in the
// batch. The picks are kept on the item while it is restoring (migration 077), so a restore a restart cut short
// finishes those picks at boot, not the whole batch.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, tid, ok, done, idle, item } = columnTrashKit('bulk-wal-big-restore-picks')
const { trashRowRange } = await import('../../server/src/services/trash-batch')
const { restoreRows, resumeTrashRestores } = await import('../../server/src/services/trash-restore')
const { HEAVY_SLICE_BYTES } = await import('../../server/src/lib/constants')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const MOST_FRAMES = Math.ceil((1.5 * HEAVY_SLICE_BYTES) / 4096)
function sheet(n: number, cell: number): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Email', 'Json']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(uuid(), sid, uid, i, JSON.stringify({ Email: `u${i}@x.co`, Json: `${i}:${'j'.repeat(cell)}` }))
    }
  }).immediate()
  return sid
}
const back = (sid: string) => db.prepare(`SELECT row_index, json_extract(data, '$.Json') AS json FROM rows
  WHERE sheet_id = ? ORDER BY row_index`).all(sid) as Array<{ row_index: number; json: string }>
const seqsOf = (id: number, keep: (rowIndex: number) => boolean) => (db.prepare(`SELECT seq, row_index
  FROM trash_rows WHERE item_id = ? ORDER BY seq`).all(id) as Array<{ seq: number; row_index: number }>)
  .filter(r => keep(r.row_index)).map(r => r.seq)
const inBatch = (id: number) => db.prepare('SELECT row_index FROM trash_rows WHERE item_id = ? ORDER BY seq').pluck()
  .all(id) as number[]

await ok('picked rows back: slices sized by bytes, each back whole at its old place, the rest kept', async () => {
  const N = 600, CELL = 100_000
  const sid = sheet(N, CELL)
  const id = (await trashRowRange(sid, uid, 0, N, 'import')).trashId!
  const picked = (i: number) => i % 6 !== 5
  const picks = seqsOf(id, picked)
  assert.equal(picks.length, 500)
  let out: Awaited<ReturnType<typeof restoreRows>> | null = null
  const r = await measure('picked rows back', async () => { out = await restoreRows(uid, id, picks) })
  assert.ok(out && 'ok' in out && out.ok.state === 'restored' && out.ok.rows === 500, JSON.stringify(out))
  assert.ok(r.w.mostTransactionFrames <= MOST_FRAMES, `a slice wrote ${r.w.mostTransactionFrames} frames`)
  const rows = back(sid)
  assert.deepEqual(rows.map(x => x.row_index), Array.from({ length: N }, (_, i) => i).filter(picked))
  assert.ok(rows.every(x => x.json === `${x.row_index}:${'j'.repeat(CELL)}`), 'every row back whole')
  assert.deepEqual(inBatch(id), Array.from({ length: N }, (_, i) => i).filter(i => !picked(i)))
  const it = item(id)!
  assert.equal(it.state, 'kept')
  assert.equal(it.row_count, 100)
  assert.equal(it.restore_picks, null)
})

await ok('a picked restore a restart cut short finishes those picks at boot, not the whole batch', async () => {
  const sid = sheet(10, 10)
  const id = (await trashRowRange(sid, uid, 0, 10, 'import')).trashId!
  const picks = seqsOf(id, i => i % 2 === 0)
  // The restart came after the first two picks were back.
  const first = db.prepare(`SELECT seq, row_index, row_id, data FROM trash_rows WHERE item_id = ?
    AND seq IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT 2`).all(id, JSON.stringify(picks)) as
    Array<{ seq: number; row_index: number; row_id: string; data: string }>
  db.transaction(() => {
    for (const r of first) {
      db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
        .run(r.row_id, sid, uid, r.row_index, r.data)
      db.prepare('DELETE FROM trash_rows WHERE item_id = ? AND seq = ?').run(id, r.seq)
    }
    db.prepare(`UPDATE trash_items SET state = 'restoring', restore_at = NULL, restored = 2, row_count = 8,
      restore_picks = ? WHERE id = ?`).run(JSON.stringify(picks), id)
  }).immediate()
  resumeTrashRestores()
  await new Promise(r => setTimeout(r, 30))
  await idle(sid)
  assert.deepEqual(back(sid).map(x => x.row_index), [0, 2, 4, 6, 8])
  assert.deepEqual(inBatch(id), [1, 3, 5, 7, 9])
  const it = item(id)!
  assert.equal(it.state, 'kept')
  assert.equal(it.restore_picks, null)
})

await closeWalCheckpointer()
done()
