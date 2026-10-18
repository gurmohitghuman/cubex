// Trash batches filled by sliced jobs, restores and purges a restart cut
// short, and the purge (services/trash-*.ts). Pins: removing duplicates fills
// one batch and restoring it puts every row back; a CSV replace cut short
// mid-move finishes moving the old rows at boot instead of deleting them; a
// restore cut short goes on at boot, and one that had put nothing back goes
// back to the trash; the purge empties what is past its days or deleted now.
import assert from 'node:assert/strict'
import restoreMod from '../../server/src/services/trash-restore'
import purgeMod from '../../server/src/services/trash-purge'
import dedupeMod from '../../server/src/services/dedupe-remove'
import batchMod from '../../server/src/services/trash-batch'
import undoMod from '../../server/src/lib/import-undo'
import readMod from '../../server/src/services/trash-read'
import moveMod from '../../server/src/lib/trash/move'
import { trashKit } from './trash-kit'
const { restoreRows, resumeTrashRestores } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { kickTrashPurge, purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')
const { removeDuplicates } = dedupeMod as typeof import('../../server/src/services/dedupe-remove')
const { openSlicedBatch } = batchMod as typeof import('../../server/src/services/trash-batch')
const { undoImport } = undoMod as typeof import('../../server/src/lib/import-undo')
const { listTrash } = readMod as typeof import('../../server/src/services/trash-read')
const { removeRows } = moveMod as typeof import('../../server/src/lib/trash/move')
const { db, uid, ok, done, idle, fixture, rowsOf, item, del } = trashKit('trash-jobs')

await ok('removing duplicates fills one batch; restoring it brings every row back', async () => {
  const sid = fixture(70)
  const before = rowsOf(sid)
  const out = await removeDuplicates(uid, sid, { columns: ['Email'] })
  assert.ok('ok' in out && out.ok.removed === 63 && out.ok.trashId !== null)
  const it = item(out.ok.trashId!)!
  assert.equal(it.how, 'duplicates')
  assert.equal(it.row_count, 63)
  // The rows left kept their places: the removed ones go back to theirs.
  const back = await restoreRows(uid, out.ok.trashId!)
  assert.ok('ok' in back && back.ok.place === 'old', JSON.stringify(back))
  await idle(sid)
  assert.deepEqual(rowsOf(sid), before)
})

await ok('a CSV replace cut short while moving the old rows: the restart moves them all, deletes none', async () => {
  const sid = fixture(30)
  const ids = rowsOf(sid).map(r => r.id)
  // The replace had moved some old rows into its batch when the server stopped.
  const batch = openSlicedBatch(sid, uid, 'import')!
  db.transaction(() => deleteRowsToTrashSlice(sid, batch, [0, 2, 4]))()
  db.prepare(`INSERT INTO import_jobs (sheet_id, user_id, is_replace, first_row, end_row, columns)
    VALUES (?, ?, 1, 0, 60, '["Email"]')`).run(sid, uid)
  const job = db.prepare('SELECT * FROM import_jobs WHERE sheet_id = ?').get(sid) as Parameters<typeof undoImport>[0]
  await undoImport(job)
  const it = item(batch)!
  assert.equal(it.state, 'kept')
  assert.equal(it.row_count, 30, 'every old row is in the batch')
  const kept = db.prepare('SELECT row_id FROM trash_rows WHERE item_id = ?').pluck().all(batch) as string[]
  assert.deepEqual(new Set(kept), new Set(ids))
})

function deleteRowsToTrashSlice(sid: string, batch: number, indexes: number[]) {
  // One slice of the replace's move, as trash-batch.ts does it.
  const rowids = db.prepare(`SELECT rowid FROM rows WHERE sheet_id = ? AND row_index IN
    (SELECT value FROM json_each(?))`).pluck().all(sid, JSON.stringify(indexes)) as number[]
  removeRows(sid, uid, { rowids }, batch, false)
}

await ok('a restore cut short goes on at boot; one that had put nothing back goes back to the trash', async () => {
  const sid = fixture(8)
  const before = rowsOf(sid)
  const out = del(sid, [0, 2, 4, 6])
  // Two rows were back when the server stopped.
  db.prepare("UPDATE trash_items SET state = 'restoring', restore_at = NULL WHERE id = ?").run(out.trashId)
  const two = db.prepare('SELECT * FROM trash_rows WHERE item_id = ? ORDER BY seq LIMIT 2').all(out.trashId) as
    Array<{ seq: number; row_index: number; row_id: string; data: string }>
  for (const r of two) {
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(r.row_id, sid, uid, r.row_index, r.data)
    db.prepare('DELETE FROM trash_rows WHERE item_id = ? AND seq = ?').run(out.trashId, r.seq)
  }
  db.prepare('UPDATE trash_items SET restored = 2, row_count = 2 WHERE id = ?').run(out.trashId)
  const idle2 = fixture(3)
  const notStarted = del(idle2, [0])
  db.prepare("UPDATE trash_items SET state = 'restoring' WHERE id = ?").run(notStarted.trashId)
  resumeTrashRestores()
  await new Promise(r => setTimeout(r, 30))
  await idle(sid)
  assert.deepEqual(rowsOf(sid), before)
  assert.equal(item(out.trashId!), undefined)
  assert.equal(item(notStarted.trashId!)!.state, 'kept')
})

await ok('the purge empties batches past their days, and what the Trash page deletes now', async () => {
  const sid = fixture(6)
  const old = del(sid, [0]).trashId!
  const fresh = del(sid, [2]).trashId!
  const now = del(sid, [4]).trashId!
  db.prepare("UPDATE trash_items SET deleted_at = datetime('now', '-31 days') WHERE id = ?").run(old)
  assert.deepEqual(purgeTrashItems(uid, [now]), [now])
  kickTrashPurge()
  for (let i = 0; i < 100 && (item(old) || item(now)); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(item(old), undefined)
  assert.equal(item(now), undefined)
  assert.ok(item(fresh))
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM trash_rows WHERE item_id IN (?, ?)').get(old, now) as
    { c: number }).c, 0)
  const list = listTrash(uid, { sheetId: sid })
  assert.deepEqual(list.items.map(i => i.id), [fresh])
})

done()
