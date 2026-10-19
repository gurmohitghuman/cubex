// A restore from the trash (services/trash-restore.ts, lib/trash/restore-rows.ts)
// never opens a deferred transaction of its own: each one reads, then writes,
// so it must take the write lock first (BEGIN IMMEDIATE). A deferred one fails
// with SQLITE_BUSY, whatever busy_timeout says, when another connection (a
// worker, the lookup thread) writes between its read and its first write: CI
// saw it in finishRestore. Checked by watching every top-level transaction a
// whole restore, a picked restore and a boot resume open.
import assert from 'node:assert/strict'
import restoreMod from '../../server/src/services/trash-restore'
import { trashKit } from './trash-kit'
const { restoreRows, resumeTrashRestores } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { db, uid, ok, done, idle, fixture, rowsOf, item, del } = trashKit('trash-restore-locks')

// Top-level transactions opened from the restore's own files without .immediate().
const deferred: string[] = []
const original = db.transaction.bind(db)
const ours = /trash-restore\.ts|restore-rows\.ts/
;(db as any).transaction = (fn: (...a: unknown[]) => unknown) => {
  const tx = original(fn)
  const watched = ((...a: unknown[]) => {
    const caller = (new Error().stack ?? '').split('\n')[2] ?? ''
    if (!db.inTransaction && ours.test(caller)) deferred.push(caller.trim())
    return tx(...a)
  }) as typeof tx
  return Object.assign(watched, { deferred: tx.deferred, immediate: tx.immediate, exclusive: tx.exclusive })
}

await ok('a whole batch restored takes the write lock first in every transaction', async () => {
  deferred.length = 0
  const sid = fixture(12)
  const before = rowsOf(sid)
  const out = del(sid, [0, 4, 8, 12])
  const res = await restoreRows(uid, out.trashId!)
  assert.ok('ok' in res, JSON.stringify(res))
  await idle(sid)
  assert.deepEqual(rowsOf(sid), before)
  assert.deepEqual(deferred, [])
})

await ok('rows picked from a batch, too', async () => {
  deferred.length = 0
  const sid = fixture(6)
  const out = del(sid, [0, 2, 4])
  const seq = db.prepare('SELECT MIN(seq) FROM trash_rows WHERE item_id = ?').pluck().get(out.trashId) as number
  const res = await restoreRows(uid, out.trashId!, [seq])
  assert.ok('ok' in res, JSON.stringify(res))
  assert.equal(item(out.trashId!)!.row_count, 2)
  assert.deepEqual(deferred, [])
})

await ok('a boot resume, both ways (going on, and back to the trash)', async () => {
  deferred.length = 0
  const sid = fixture(6)
  const out = del(sid, [0, 2])
  db.prepare("UPDATE trash_items SET state = 'restoring', restore_at = NULL, restored = 1 WHERE id = ?")
    .run(out.trashId)
  const other = fixture(3)
  const notStarted = del(other, [0])
  db.prepare("UPDATE trash_items SET state = 'restoring' WHERE id = ?").run(notStarted.trashId)
  resumeTrashRestores()
  await new Promise(r => setTimeout(r, 30))
  await idle(sid)
  assert.equal(item(out.trashId!), undefined)
  assert.equal(item(notStarted.trashId!)!.state, 'kept')
  assert.deepEqual(deferred, [])
})

done()
