// A deleted column and deleted rows of its sheet (migration 054). Rows deleted after the column: its cells for
// them stay in the item (skipped), and restored later they go into the column the others went back to, or,
// when that column is gone or renamed since, come back as a column of their own (the answer says so). A cell
// whose row holds a value now is never overwritten and stays in the item (kept) until it is empty there. Rows
// deleted before their column hold its cells: restored first they add a plain column of its name and the
// column comes back beside it, restored together (or after it) they come back into it. Batches of rows alone
// are restored newest deletion first.
import assert from 'node:assert/strict'
import readMod from '../../server/src/services/trash-read'
import rowsMod from '../../server/src/services/trash-rows'
import restoreRowsMod from '../../server/src/services/trash-restore'
import renameMod from '../../server/src/services/column-rename'
import actionsMod from '../../server/src/services/trash-actions'
import descMod from '../../server/src/lib/column-descriptions'
import { columnTrashKit } from './column-trash-kit'
const { getTrashEntry } = readMod as typeof import('../../server/src/services/trash-read')
const { deleteRowsToTrash } = rowsMod as typeof import('../../server/src/services/trash-rows')
const { restoreRows } = restoreRowsMod as typeof import('../../server/src/services/trash-restore')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { holdersFirst } = actionsMod as typeof import('../../server/src/services/trash-actions')
const { sheetColumnDescriptions, writeColumnDescription } = descMod as
  typeof import('../../server/src/lib/column-descriptions')
const k = columnTrashKit('column-trash-rows')
const { db, uid, ok, done, idle, sheet, order, cells, item, stored, del, restore, restoreOne, history } = k

const leads = () => sheet(['Email', 'Notes', 'Name'], [
  { Email: 'a@x.co', Notes: 'first', Name: 'A' }, { Email: 'b@x.co', Notes: '', Name: 'B' },
  { Email: 'c@x.co', Name: 'C' }, { Email: 'd@x.co', Notes: { deep: [1, 2] }, Name: 'D' },
  { Email: 'e@x.co', Notes: 42, Name: 'E' },
])

await ok('rows deleted after their column: restored later, the leftover cells go into the column', async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  const rows = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0, 4] }))().trashId!
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual([got.name, got.cells_restored, got.cells_skipped], ['Notes', 1, 2])
  assert.equal(getTrashEntry(uid, id)!.note, 'Its other cells went back to "Notes". These stayed: their rows were '
    + 'gone, or held a value there. Restored again, each goes into it once its row is back and empty there.')
  assert.ok('ok' in await restoreRows(uid, rows))
  await idle(sid)
  const rest = (await restoreOne(id)).restored as any
  assert.deepEqual([rest.name, rest.renamed, rest.cells_restored, rest.cells_skipped, rest.position],
    ['Notes', false, 2, 0, 1])
  assert.equal(rest.setup.note, 'Its setup came back with "Notes" already.')
  assert.deepEqual(rest.references_dropped, [])
  assert.equal(rest.note, 'These cells\' rows were gone or held a value when "Notes" came back; they went into it '
    + 'now.')
  assert.equal(item(id), undefined)
  assert.deepEqual(order(sid), ['Email', 'Notes', 'Name'])
  assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, '{"deep":[1,2]}', 42])
  assert.equal(history(sid).at(-1)!.summary, 'Restored 2 cells of the column "Notes" into "Notes" from the trash')
})

await ok('... restored with the column in one request, the rows go first and every cell comes back', async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  const rows = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0, 4] }))().trashId!
  const results = await restore([id, rows])
  assert.deepEqual(results.map(r => r.trash_id), [rows, id], 'the newest deletion first')
  assert.ok(results.every(r => r.restored), JSON.stringify(results))
  assert.equal((results[1].restored as any).cells_skipped, 0)
  await idle(sid)
  assert.equal(item(id), undefined)
  assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, '{"deep":[1,2]}', 42])
})

await ok('a cell whose row holds a value now under its name is never overwritten, and stays in the trash',
  async () => {
    const sid = leads()
    const id = (await del(sid, 'Notes'))!
    // Something wrote under the old name meanwhile, without listing it (the column is still gone).
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Notes', 'newer') WHERE id = ?`).run(`r3-${sid}`)
    const got = (await restoreOne(id)).restored as any
    assert.deepEqual([got.cells_restored, got.cells_skipped, got.cells_kept], [2, 0, 1])
    assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, 'newer', 42])
    assert.equal(got.note, `1 cell stayed in the trash (trash_id ${id}): their rows hold a value in "Notes" now, `
      + 'which a restore never overwrites. Empty those cells and restore it again to put them back.')
    assert.deepEqual([item(id)!.state, item(id)!.restore_name, item(id)!.row_count], ['kept', 'Notes', 1])
    assert.deepEqual(stored(id).map(r => [r.row_id, JSON.parse(r.data)]), [[`r3-${sid}`, { Notes: { deep: [1, 2] } }]])
    const again = (await restoreOne(id)).restored as any
    assert.deepEqual([again.cells_restored, again.cells_kept], [0, 1], 'still held: kept again, still in the trash')
    assert.equal(stored(id).length, 1)
    db.prepare(`UPDATE rows SET data = json_remove(data, '$.Notes') WHERE id = ?`).run(`r3-${sid}`)
    const back = (await restoreOne(id)).restored as any
    assert.deepEqual([back.name, back.cells_restored, back.cells_kept], ['Notes', 1, 0])
    assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, '{"deep":[1,2]}', 42])
    assert.equal(item(id), undefined)
  })

await ok('leftovers whose column is gone or renamed since come back as a column of their own, and say so',
  async () => {
    for (const gone of ['deleted', 'renamed']) {
      const sid = leads()
      const id = (await del(sid, 'Notes'))!
      const rows = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0, 4] }))().trashId!
      assert.equal(((await restoreOne(id)).restored as any).cells_skipped, 2)
      if (gone === 'deleted') await del(sid, 'Notes')
      else assert.ok('ok' in await renameSheetColumn(sid, uid, 'Notes', 'Remarks'))
      assert.ok('ok' in await restoreRows(uid, rows))
      await idle(sid)
      const got = (await restoreOne(id)).restored as any
      assert.deepEqual([got.name, got.renamed, got.cells_restored, got.cells_skipped], ['Notes', false, 2, 0])
      assert.equal(got.note, 'The column its other cells went back to, "Notes", is gone or renamed, so these came '
        + 'back as a column of their own, "Notes", with the setup the column had.')
      assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, null, 42])
      assert.ok(order(sid).includes('Notes'))
    }
  })

// Rows 0 and 1 deleted (a batch holding their Notes), then the column (the rest of its cells).
async function rowsThenColumn() {
  const sid = leads()
  writeColumnDescription(sid, uid, 'Notes', 'Kept notes')
  const rows = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0, 3] }))().trashId!
  const column = (await del(sid, 'Notes'))!
  return { sid, rows, column }
}

await ok('rows deleted before their column: restored first they add it back plain, and it comes back beside',
  async () => {
    const { sid, rows, column } = await rowsThenColumn()
    const r = await restoreRows(uid, rows)
    assert.ok('ok' in r && r.ok.columns_added.join() === 'Notes')
    await idle(sid)
    const got = (await restoreOne(column)).restored as any
    assert.equal(got.name, 'Notes (restored)')
    assert.deepEqual(order(sid), ['Email', 'Notes (restored)', 'Name', 'Notes'])
    assert.equal(sheetColumnDescriptions(sid, uid).get('Notes (restored)'), 'Kept notes')
    const all = db.prepare(`SELECT id, json_extract(data, '$.Notes') AS a,
      json_extract(data, '$."Notes (restored)"') AS b FROM rows WHERE sheet_id = ? ORDER BY id`).all(sid)
    assert.deepEqual(all, [
      { id: `r0-${sid}`, a: 'first', b: null }, { id: `r1-${sid}`, a: null, b: null },
      { id: `r2-${sid}`, a: null, b: null }, { id: `r3-${sid}`, a: '{"deep":[1,2]}', b: null },
      { id: `r4-${sid}`, a: null, b: 42 }])
  })

await ok('... restored together (or the column first), the rows come back into the column', async () => {
  for (const together of [true, false]) {
    const { sid, rows, column } = await rowsThenColumn()
    if (together) {
      const results = await restore([rows, column])
      assert.deepEqual(results.map(r => r.trash_id), [column, rows], 'the column goes first')
      assert.ok(results.every(r => r.restored), JSON.stringify(results))
      assert.deepEqual((results[1].restored as any).columns_added, [])
    } else {
      assert.ok((await restoreOne(column)).restored)
      const r = await restoreRows(uid, rows)
      assert.ok('ok' in r && r.ok.columns_added.length === 0)
    }
    await idle(sid)
    assert.deepEqual(order(sid), ['Email', 'Notes', 'Name'])
    assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, '{"deep":[1,2]}', 42])
    assert.equal(sheetColumnDescriptions(sid, uid).get('Notes'), 'Kept notes')
  }
})

await ok('batches of rows alone are restored newest deletion first, whatever order they are given in', async () => {
  const sid = leads()
  const older = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0] }))().trashId!
  const newer = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [1] }))().trashId!
  assert.ok(newer > older)
  assert.deepEqual(holdersFirst(uid, [older, newer]), [newer, older])
  assert.deepEqual(holdersFirst(uid, [newer, older]), [newer, older])
  const results = await restore([older, newer])
  assert.deepEqual(results.map(r => r.trash_id), [newer, older])
  assert.ok(results.every(r => r.restored), JSON.stringify(results))
  await idle(sid)
  assert.deepEqual(cells(sid, 'Email'), ['a@x.co', 'b@x.co', 'c@x.co', 'd@x.co', 'e@x.co'])
})

done()
