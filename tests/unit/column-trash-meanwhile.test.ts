// What happens to a column in the trash while it moves in or comes back (migration 054). A move whose slice
// fails (its strip statement throws) is tried again with the sheet still busy: the delete answers "moving", a
// restore meanwhile is refused, and the retry ends with every cell in the item once and the item kept. A
// column made while a big restore runs (one answering "restoring") never takes the restored column's cells:
// one made under its name (in any case) is refused until it is back, and one made at its old place keeps its
// cells while the restored column comes back there.
import assert from 'node:assert/strict'
import addMod from '../../server/src/services/column-add'
import deleteMod from '../../server/src/services/column-delete'
import busyMod from '../../server/src/lib/sheet-busy'
import constMod from '../../server/src/lib/constants'
import { columnTrashKit } from './column-trash-kit'
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { TRASH_RESTORE_WAIT_ROWS } = constMod as typeof import('../../server/src/lib/constants')
const k = columnTrashKit('column-trash-meanwhile')
const { db, uid, ok, done, idle, sheet, order, cells, item, stored, del, restoreOne } = k
console.error = () => {}

// Each statement starting with `sql` prepared from now on runs `each(n)` after its n-th run (from 1).
function onEach(sql: string, each: (n: number) => void): () => void {
  const prepare = db.prepare.bind(db)
  let n = 0
  ;(db as any).prepare = (text: string) => {
    const stmt = prepare(text)
    if (!text.trimStart().startsWith(sql)) return stmt
    const run = stmt.run.bind(stmt)
    stmt.run = (...args: unknown[]) => { const out = run(...args); each(++n); return out }
    return stmt
  }
  return () => { (db as any).prepare = prepare }
}
const until = async (what: () => boolean, ms = 60_000) => {
  for (const end = Date.now() + ms; !what() && Date.now() < end;) await new Promise(r => setTimeout(r, 20))
  return what()
}
const STRIP = 'UPDATE rows SET data = json_remove(data, ?)'

await ok('a move whose slice fails is tried again: every cell ends in the item once, and it ends kept', async () => {
  const n = 6_000
  const sid = sheet(['Email', 'Big'], Array.from({ length: n }, (_, i) => ({ Email: `${i}`, Big: `v${i}` })))
  // The third slice's strip fails once (its copy into the item goes back with it); the retry finds it.
  const release = onEach(STRIP, at => { if (at === 3) throw new Error('disk I/O error') })
  try {
    const out = await deleteSheetColumn(sid, uid, 'Big', { bumpDataVersion: true })
    assert.ok('ok' in out && out.moving === true, JSON.stringify(out))
    const id = out.trashId!
    assert.equal(item(id)!.state, 'moving')
    assert.equal(item(id)!.row_count, 2_000, 'the two slices before it are in, the failed one went back')
    assert.ok(sheetBusyWith(sid), 'the sheet stays busy until the move is done')
    const refused = await restoreOne(id)
    assert.deepEqual([refused.fail, refused.error], ['conflict',
      '"Big" is still moving to the trash, try again in a moment.'])
    assert.ok(await until(() => item(id)!.state === 'kept'), 'the retry ends it')
    await idle(sid)
    assert.equal(item(id)!.row_count, n)
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS cells, COUNT(DISTINCT row_id) AS rows FROM trash_rows '
      + 'WHERE item_id = ?').get(id), { cells: n, rows: n }, 'each cell once')
    assert.deepEqual(cells(sid, 'Big'), Array.from({ length: n }, () => null))
    assert.equal(db.prepare('SELECT COUNT(*) FROM column_purges WHERE sheet_id = ?').pluck().get(sid), 0)
    assert.equal(stored(id).at(-1)!.data, JSON.stringify({ Big: `v${n - 1}` }))
    assert.equal(((await restoreOne(id)).restored as any).cells_restored, n)
    assert.deepEqual(cells(sid, 'Big'), Array.from({ length: n }, (_, i) => `v${i}`))
  } finally { release() }
})

await ok('a column made while a big restore runs never takes its cells: refused under its name, kept at its place',
  async () => {
    const n = TRASH_RESTORE_WAIT_ROWS + 1
    const sid = sheet(['Email', 'Big'], Array.from({ length: n }, (_, i) => ({ Email: `${i}`, Big: `b${i}` })))
    const id = (await del(sid, 'Big'))!
    // Each slice putting cells back waits a little, so the restore is still going when the columns are made.
    const pause = new Int32Array(new SharedArrayBuffer(4))
    const release = onEach('DELETE FROM trash_rows WHERE item_id = ? AND seq IN', () => Atomics.wait(pause, 0, 0, 5))
    try {
      const got = (await restoreOne(id)).restored as any
      assert.deepEqual([got.state, got.name], ['restoring', 'Big'])
      assert.ok(await until(() => item(id)!.restored > 0), 'some cells are back')
      const words = 'The column "Big" is being restored from the trash, so that name is taken. Pick another one.'
      for (const name of ['Big', 'big', 'BIG']) {
        assert.deepEqual(addSheetColumn(sid, uid, name, { seedEmptyRow: false }), { fail: 'collision', error: words },
          name)
      }
      assert.deepEqual(addSheetColumn(sid, uid, 'Other', { seedEmptyRow: false }), { ok: true, name: 'Other' })
      assert.deepEqual(order(sid), ['Email', 'Other'], 'it sits where Big was')
      assert.equal(item(id)!.state, 'restoring')
    } finally { release() }
    assert.ok(await until(() => item(id) === undefined), 'every cell is back')
    await idle(sid)
    assert.deepEqual(order(sid), ['Email', 'Big', 'Other'], 'back at its old place, the other one after it')
    assert.deepEqual(cells(sid, 'Big'), Array.from({ length: n }, (_, i) => `b${i}`))
    assert.deepEqual(cells(sid, 'Other'), Array.from({ length: n }, () => null), 'none of its cells changed')
    assert.deepEqual(addSheetColumn(sid, uid, 'big', { seedEmptyRow: false }).fail, 'collision')
  })

done()
