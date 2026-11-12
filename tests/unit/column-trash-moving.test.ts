// A big column's way into the trash and back (migration 054). Its delete waits for the cells to move into the
// item only COLUMN_DELETE_WAIT_MS (services/column-trash.ts moveWithin), then answers "moving": the column is
// gone from the sheet, the move goes on with the sheet busy, and the item ends holding every cell once. While it
// moves, GET /trash/:id and list_trash show "moving", the change log's line says in_trash, and a restore is
// refused (REST 409, MCP a failed item).
// With Settings at 0 days the delete waits for its strip however long, as before. A restore of over 20,000 cells
// answers "restoring", and the column shows once they are all back; when its setup can't come back by then,
// the change log says why. Each slice of the move is held a little (its statement sleeps once it has run), so
// the move outlasts the wait on any machine.
import assert from 'node:assert/strict'
import storeMod from '../../server/src/lib/trash/store'
import writeMod from '../../server/src/services/setup-version-write'
import columnsMod from '../../server/src/lib/sheet-columns'
import sheetsMod from '../../server/src/services/trash-sheets'
import constMod from '../../server/src/lib/constants'
import { columnTrashKit } from './column-trash-kit'
import { trashSurfaces } from './column-trash-surfaces'
const { setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { writeLookupSetup } = writeMod as typeof import('../../server/src/services/setup-version-write')
const { appendColumnsToOrder } = columnsMod as typeof import('../../server/src/lib/sheet-columns')
const { trashSheet } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { COLUMN_DELETE_WAIT_MS, TRASH_RESTORE_WAIT_ROWS } = constMod as typeof import('../../server/src/lib/constants')
const k = columnTrashKit('column-trash-moving')
const { db, uid, tid, ok, done, idle, sheet, order, cells, item, stored, del, restoreOne, history } = k
console.error = () => {}
const api = await trashSurfaces(uid, 'read,write')

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// Each statement starting with `sql` prepared from now on sleeps `ms` after each run, inside its slice.
function holdEach(sql: string, ms: number): () => void {
  const prepare = db.prepare.bind(db)
  ;(db as any).prepare = (text: string) => {
    const stmt = prepare(text)
    if (!text.trimStart().startsWith(sql)) return stmt
    const run = stmt.run.bind(stmt)
    stmt.run = (...args: unknown[]) => { const out = run(...args); pause(ms); return out }
    return stmt
  }
  return () => { (db as any).prepare = prepare }
}
const COPY = 'INSERT INTO trash_rows (item_id, seq, row_index, row_id, data)'
const until = async (what: () => boolean, ms = 180_000) => {
  for (const end = Date.now() + ms; !what() && Date.now() < end;) await new Promise(r => setTimeout(r, 20))
  return what()
}
const big = (n: number) => sheet(['Email', 'Big'], Array.from({ length: n }, (_, i) =>
  ({ Email: `u${i}@x.co`, Big: `v${i}:${'x'.repeat(52)}` })))
const stillMoving = (name: string) => `"${name}" is still moving to the trash, try again in a moment.`

await ok('a 300,000-row delete answers "moving" within its wait; a restore meanwhile is refused; all cells end in',
  async () => {
    const n = 300_000
    const sid = big(n)
    const release = holdEach(COPY, 20)
    let id = 0
    try {
      const t0 = Date.now()
      const out = await api.rest('DELETE', `/sheets/${sid}/columns/Big`)
      const took = Date.now() - t0
      assert.equal(out.status, 200, JSON.stringify(out.body))
      assert.ok(took >= COLUMN_DELETE_WAIT_MS - 50 && took < COLUMN_DELETE_WAIT_MS + 1500, `answered in ${took} ms`)
      id = out.body.trash.trash_id
      assert.equal(out.body.trash.state, 'moving')
      assert.equal(out.body.trash.note, 'Its cells are still going to the trash, in the background: the column is '
        + `gone from the sheet already. GET /api/v1/trash/${id} shows state "moving" until they are all in; a `
        + 'restore before then is refused, so try again in a moment.')
      assert.deepEqual(order(sid), ['Email'], 'gone from the sheet at once')
      assert.equal(item(id)!.state, 'moving')
      assert.ok(item(id)!.row_count < n, `still moving: ${item(id)!.row_count} cells in`)
      assert.equal((await api.rest('GET', `/trash/${id}`)).body.state, 'moving')
      assert.equal((await api.call('list_trash', { trash_id: id })).body.item.state, 'moving')
      const refused = await api.rest('POST', `/trash/${id}/restore`)
      assert.deepEqual([refused.status, refused.body], [409, { error: stillMoving('Big') }])
      const viaMcp = await api.call('restore_from_trash', { trash_ids: [id] })
      assert.deepEqual(viaMcp.body.results, [{ trash_id: id, error: stillMoving('Big'), fail: 'conflict' }])
      assert.equal(item(id)!.state, 'moving', 'a refused restore changes nothing')
    } finally { release() }
    assert.ok(await until(() => item(id)!.state === 'kept'), 'the move ends')
    await idle(sid)
    assert.equal(item(id)!.row_count, n)
    assert.equal(db.prepare('SELECT COUNT(DISTINCT row_id) FROM trash_rows WHERE item_id = ?').pluck().get(id), n)
    assert.equal(db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND json_type(data, '$.Big') IS NOT NULL`)
      .pluck().get(sid), 0, 'no row keeps the cell')
    assert.equal(db.prepare('SELECT COUNT(*) FROM column_purges WHERE sheet_id = ?').pluck().get(sid), 0)
    assert.deepEqual(JSON.parse(history(sid).at(-1)!.detail!), { trash_id: id })
    assert.equal(stored(id).at(-1)!.data, JSON.stringify({ Big: `v${n - 1}:${'x'.repeat(52)}` }))
  })

await ok('over MCP, a delete past its wait says so, and list_trash and the change log read while it moves',
  async () => {
    const sid = big(6_000)
    const release = holdEach(COPY, 1_000)
    try {
      const out = await api.call('delete_column', { sheet_id: sid, column: 'Big' })
      const id = out.body.trash.trash_id
      assert.deepEqual([out.isError, out.body.deleted, out.body.trash.state], [false, true, 'moving'])
      assert.equal(out.body.trash.note, 'Its cells are still going to the trash, in the background: the column is '
        + `gone from the sheet already. list_trash with trash_id ${id} shows state "moving" until they are all in; a `
        + 'restore before then is refused, so try again in a moment.')
      const listed = await api.call('list_trash', { kind: 'column', sheet_id: sid })
      assert.deepEqual(listed.body.items.map((i: any) => [i.id, i.state]), [[id, 'moving']])
      const log = await api.call('get_sheet_history', { sheet_id: sid })
      const line = log.body.changes[0]
      assert.deepEqual([log.isError, line.action, line.detail.trash_id, line.in_trash, item(id)!.state],
        [false, 'column_deleted', id, true, 'moving'], 'read while it moves: in the trash, as list_trash says')
    } finally { release() }
    await idle(sid)
    assert.ok(await until(() => !k.db.prepare('SELECT 1 FROM column_purges WHERE sheet_id = ?').get(sid)))
    const id = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND kind = 'column'`).pluck()
      .get(sid) as number
    assert.deepEqual([item(id)!.state, item(id)!.row_count], ['kept', 6_000])
    const inTrash = async () => (await api.call('get_sheet_history', { sheet_id: sid })).body.changes
      .find((c: any) => c.action === 'column_deleted').in_trash
    assert.equal(await inTrash(), true)
    assert.ok((await restoreOne(id)).restored)
    assert.equal(await inTrash(), false, 'restored: no longer in the trash')
  })

await ok("the app's delete past its wait answers moving (its toast says the cells are still going)", async () => {
  const sid = big(6_000)
  const release = holdEach(COPY, 1_000)
  try {
    const out = await api.app('DELETE', `/sheets/${sid}/columns/Big`)
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.deepEqual(out.body, { message: 'Column deleted successfully',
      trash: { id: out.body.trash.id, days: 30, moving: true } })
  } finally { release() }
  assert.ok(await until(() => !db.prepare('SELECT 1 FROM column_purges WHERE sheet_id = ?').get(sid)))
  await idle(sid)
})

await ok('Settings keeping 0 days: the delete waits for its strip, however long, as before', async () => {
  setTrashDays(uid, 0)
  const sid = big(15_000)
  const release = holdEach('UPDATE rows SET data = json_remove(data, ?)', 2_000)
  try {
    const t0 = Date.now()
    const out = await api.rest('DELETE', `/sheets/${sid}/columns/Big`)
    const took = Date.now() - t0
    assert.deepEqual([out.status, out.body], [200, { deleted: true, trash: { trash_id: null,
      note: 'Deleted: Settings keeps deleted items 0 days, so nothing went to the trash.' } }])
    assert.ok(took > COLUMN_DELETE_WAIT_MS, `it waited: ${took} ms`)
    assert.equal(db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND json_type(data, '$.Big') IS NOT NULL`)
      .pluck().get(sid), 0, 'every cell was gone when it answered')
    assert.equal(db.prepare(`SELECT COUNT(*) FROM trash_items WHERE sheet_id = ?`).pluck().get(sid), 0)
  } finally { release(); setTrashDays(uid, 30) }
})

await ok('a column of over 20,000 cells answers "restoring" and shows once its cells are all back', async () => {
  const n = TRASH_RESTORE_WAIT_ROWS + 1
  const sid = sheet(['Email', 'Big'], Array.from({ length: n }, (_, i) => ({ Email: `${i}`, Big: `b${i}` })))
  const id = (await del(sid, 'Big'))!
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual([got.state, got.name, got.position, got.cells, got.cells_restored], ['restoring', 'Big', null, n, 0])
  assert.equal(got.note, `Its ${n.toLocaleString('en-US')} cells are going back in the background, and the column `
    + 'shows once they are all back (the trash shows how far it got).')
  assert.equal(got.setup.note, 'It had no setup of its own: it is a plain column again.')
  assert.deepEqual(order(sid), ['Email'], 'not listed while its cells go back')
  await idle(sid)
  assert.equal(item(id), undefined)
  assert.deepEqual(order(sid), ['Email', 'Big'])
  const back = cells(sid, 'Big')
  assert.equal(back.length, n)
  assert.ok(back.every((v, i) => v === `b${i}`))
})

await ok('a restore past its wait whose setup can no longer come back at the end logs why', async () => {
  const n = TRASH_RESTORE_WAIT_ROWS + 1
  const accounts = sheet(['Domain', 'Owner'], [{ Domain: 'acme.com', Owner: 'Kim' }], 'Accounts')
  const sid = sheet(['Domain'], Array.from({ length: n }, (_, i) => ({ Domain: `d${i}.com`, Owner: `o${i}` })))
  db.transaction(() => {
    appendColumnsToOrder(sid, uid, ['Owner'])
    writeLookupSetup(sid, uid, 'Owner', { kind: 'lookup', source: 'Domain', otherSheetId: accounts,
      matchColumn: 'Domain', match: 'equals', returns: 'value', returnColumns: ['Owner'], limit: 1 }, false)
  })()
  const id = (await del(sid, 'Owner'))!
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual([got.state, got.setup.kind, got.setup.note], ['restoring', 'lookup', 'Its setup comes back '
    + 'with it once all its cells are back; nothing runs.'])
  assert.ok('ok' in trashSheet(uid, tid, accounts), 'the sheet it looks in goes while its cells go back')
  assert.ok(await until(() => item(id) === undefined), 'every cell is back')
  await idle(sid)
  const line = history(sid).at(-1)!
  assert.equal(line.action, 'column_restored')
  assert.deepEqual(JSON.parse(line.detail!).setup, { kind: 'lookup', restored: false,
    why: 'the sheet it looks in is gone or in the trash' })
  assert.equal(db.prepare('SELECT COUNT(*) FROM lookup_columns WHERE sheet_id = ?').pluck().get(sid), 0)
  assert.equal(cells(sid, 'Owner')[n - 1], `o${n - 1}`)
})

await api.close()
done()
