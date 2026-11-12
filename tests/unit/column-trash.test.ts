// A deleted column goes to the trash (migration 054: services/column-trash.ts, lib/trash/column-move.ts,
// services/trash-restore-column.ts). Pins: the delete makes one 'column' item holding only the cells that had
// a value (row id, place), its place, description and setup, and leaves the rows as a delete always did;
// Settings keeping 0 days deletes it at once with no item; restore puts it back at its place under its name, or
// "<name> (restored)", "(restored 2)" when a column has it now (in any case), cut to fit the longest column name,
// its cells on the rows still there. Refusals: column-trash-refusals.test.ts; rows and leftovers:
// column-trash-rows.test.ts; big columns: column-trash-moving.test.ts.
import assert from 'node:assert/strict'
import storeMod from '../../server/src/lib/trash/store'
import addMod from '../../server/src/services/column-add'
import readMod from '../../server/src/services/trash-read'
import descMod from '../../server/src/lib/column-descriptions'
import rowsSqlMod from '../../server/src/lib/sql-rows'
import { columnTrashKit } from './column-trash-kit'
const { setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
const { getTrashEntry, readTrashRows } = readMod as typeof import('../../server/src/services/trash-read')
const { sheetColumnDescriptions, writeColumnDescription } = descMod as
  typeof import('../../server/src/lib/column-descriptions')
const { sanitizeColumnName } = rowsSqlMod as typeof import('../../server/src/lib/sql-rows')
const k = columnTrashKit('column-trash')
const { db, uid, ok, done, sheet, order, cells, item, stored, del, restoreOne, history } = k

const leads = () => sheet(['Email', 'Notes', 'Name'], [
  { Email: 'a@x.co', Notes: 'first', Name: 'A' },
  { Email: 'b@x.co', Notes: '', Name: 'B' },          // an empty cell isn't kept
  { Email: 'c@x.co', Name: 'C' },                     // nor a missing one
  { Email: 'd@x.co', Notes: { deep: [1, 2] }, Name: 'D' },
  { Email: 'e@x.co', Notes: 42, Name: 'E' },
])

await ok('the delete puts the cells that had a value in one column item; the rows lose the cell', async () => {
  const sid = leads()
  writeColumnDescription(sid, uid, 'Notes', 'What the call said')
  const id = (await del(sid, 'Notes'))!
  const it = item(id)!
  assert.equal(it.kind, 'column')
  assert.equal(it.how, 'column')
  assert.equal(it.state, 'kept')
  assert.equal(it.column_name, 'Notes')
  assert.equal(it.column_position, 1)
  assert.equal(it.row_count, 3)
  assert.deepEqual(JSON.parse(it.columns), ['Notes'])
  assert.deepEqual(JSON.parse(it.column_setup), { name: 'Notes', description: 'What the call said', fill: null,
    autoRun: null })
  assert.deepEqual(stored(id).map(r => [r.row_id, r.row_index, JSON.parse(r.data)]), [
    [`r0-${sid}`, 0, { Notes: 'first' }], [`r3-${sid}`, 3, { Notes: { deep: [1, 2] } }],
    [`r4-${sid}`, 4, { Notes: 42 }],
  ])
  assert.equal(it.bytes, stored(id).reduce((n, r) => n + Buffer.byteLength(r.data), 0))
  assert.deepEqual(order(sid), ['Email', 'Name'])
  assert.deepEqual(cells(sid, 'Notes'), [null, null, null, null, null])
  assert.equal(db.prepare('SELECT COUNT(*) FROM column_purges WHERE sheet_id = ?').pluck().get(sid), 0)
  assert.equal(sheetColumnDescriptions(sid, uid).has('Notes'), false, 'its description goes with it, as before')
  const line = history(sid).at(-1)!
  assert.equal(line.action, 'column_deleted')
  assert.equal(line.summary, 'Deleted the column "Notes" (to the trash, kept 30 days)')
  assert.deepEqual(JSON.parse(line.detail!), { trash_id: id })
  const entry = getTrashEntry(uid, id)!
  assert.equal(entry.column, 'Notes')
  assert.equal(entry.cells, 3)
  assert.equal(entry.column_kind, 'a plain column')
  assert.equal(entry.references_dropped, 0)
  const page = readTrashRows(uid, id, { limit: 2 })
  assert.ok(!('fail' in page))
  assert.deepEqual(page.rows.map(r => [r.row_id, r.old_row_index, r.cells]), [
    [`r0-${sid}`, 0, { Notes: 'first' }], [`r3-${sid}`, 3, { Notes: { deep: [1, 2] } }]])
  const found = readTrashRows(uid, id, { contains: 'FIR' })
  assert.ok(!('fail' in found) && found.rows.length === 1 && found.rows[0].row_id === `r0-${sid}`)
})

await ok('restoring puts it back at its place, its cells (nested ones too) and description, and logs it', async () => {
  const sid = leads()
  writeColumnDescription(sid, uid, 'Notes', 'What the call said')
  const id = (await del(sid, 'Notes'))!
  const r = await restoreOne(id)
  assert.ok(r.restored, JSON.stringify(r))
  const got = r.restored as any
  assert.equal(got.kind, 'column')
  assert.equal(got.state, 'restored')
  assert.equal(got.name, 'Notes')
  assert.equal(got.renamed, false)
  assert.equal(got.position, 1)
  assert.deepEqual([got.cells, got.cells_restored, got.cells_skipped, got.cells_kept], [3, 3, 0, 0])
  assert.deepEqual(got.setup, { kind: 'plain', restored: false, run_id: null,
    note: 'It had no setup of its own: it is a plain column again.' })
  assert.deepEqual(got.references_dropped, [])
  assert.equal(got.note, undefined)
  assert.deepEqual(order(sid), ['Email', 'Notes', 'Name'])
  assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, '{"deep":[1,2]}', 42])
  assert.equal(sheetColumnDescriptions(sid, uid).get('Notes'), 'What the call said')
  assert.equal(item(id), undefined)
  assert.equal(stored(id).length, 0)
  const line = history(sid).at(-1)!
  assert.equal(line.action, 'column_restored')
  assert.equal(line.summary, 'Restored the column "Notes" from the trash (3 cells back)')
  assert.deepEqual(JSON.parse(line.detail!), { trash_id: id, old_name: 'Notes', cells: 3, skipped: 0, kept: 0,
    setup: { kind: 'plain', restored: false }, references_dropped: [] })
})

await ok('a taken name (in any case) gives "(restored)", then "(restored 2)"; rows gone are skipped', async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  assert.ok('ok' in addSheetColumn(sid, uid, 'notes', { seedEmptyRow: false }))
  db.prepare(`UPDATE rows SET data = json_set(data, '$.notes', 'mine') WHERE id = ?`).run(`r0-${sid}`)
  db.prepare('DELETE FROM rows WHERE id = ?').run(`r4-${sid}`)
  const got = (await restoreOne(id)).restored as any
  assert.equal(got.name, 'Notes (restored)')
  assert.equal(got.renamed, true)
  assert.deepEqual([got.cells_restored, got.cells_skipped, got.cells_kept], [2, 1, 0])
  assert.equal(got.note, 'Its name "Notes" was taken, so it came back as "Notes (restored)". Setups that name '
    + '"Notes" (prompts, formulas, requests, clean and lookup columns) read the column now called "Notes". 1 cell '
    + `stayed in the trash (trash_id ${id}): their rows are gone, maybe in the trash too. Once those rows are back, `
    + 'restore it again and they go into "Notes (restored)".')
  const left = item(id)!
  assert.deepEqual([left.state, left.restore_name, left.row_count, left.column_dropped], ['kept',
    'Notes (restored)', 1, '[]'])
  assert.deepEqual(stored(id).map(r => r.row_id), [`r4-${sid}`], 'the cell whose row is gone waits')
  assert.deepEqual(order(sid), ['Email', 'Notes (restored)', 'Name', 'notes'])
  assert.deepEqual(cells(sid, 'notes'), ['mine', null, null, null])
  assert.deepEqual(cells(sid, 'Notes (restored)'), ['first', null, null, '{"deep":[1,2]}'])
  assert.equal(history(sid).at(-1)!.summary,
    'Restored the column "Notes" as "Notes (restored)" from the trash (2 cells back)')
  const again = (await del(sid, 'Notes (restored)'))!
  const third = (await del(sid, 'Email'))!
  assert.ok('ok' in addSheetColumn(sid, uid, 'Notes (Restored)', { seedEmptyRow: false }))
  const back = (await restoreOne(again)).restored as any
  assert.equal(back.name, 'Notes (restored) (restored)')
  assert.ok((await restoreOne(third)).restored)
  const twice = sheet(['A', 'B (restored)'], [{ A: 'x', B: 'y' }])
  const b = (await del(twice, 'B (restored)'))!
  assert.ok('ok' in addSheetColumn(twice, uid, 'B (restored)', { seedEmptyRow: false }))
  const named = sheet(['A', 'B'], [{ A: 'x', B: 'y' }])
  const bb = (await del(named, 'B'))!
  for (const c of ['B', 'B (restored)']) assert.ok('ok' in addSheetColumn(named, uid, c, { seedEmptyRow: false }))
  assert.equal(((await restoreOne(bb)).restored as any).name, 'B (restored 2)')
  assert.equal(((await restoreOne(b)).restored as any).name, 'B (restored) (restored)')
})

await ok('a 200-character name taken comes back cut to fit, "(restored)" whole, never through an emoji', async () => {
  const long = `${'a'.repeat(188)}🙂${'z'.repeat(10)}`
  assert.equal(long.length, 200)
  const sid = sheet(['Email', long], [{ Email: 'x', [long]: 'kept' }])
  const first = (await del(sid, long))!
  assert.ok('ok' in addSheetColumn(sid, uid, long, { seedEmptyRow: false }))
  const got = (await restoreOne(first)).restored as any
  assert.equal(got.name, `${'a'.repeat(188)} (restored)`, 'cut before the emoji, not through it')
  assert.equal(sanitizeColumnName(got.name), got.name)
  assert.deepEqual(cells(sid, got.name), ['kept'])
  const second = (await del(sid, long))!
  assert.ok('ok' in addSheetColumn(sid, uid, long, { seedEmptyRow: false }))
  const again = (await restoreOne(second)).restored as any
  assert.equal(again.name, `${'a'.repeat(187)} (restored 2)`)
  assert.equal(again.name.length, 200)
  assert.deepEqual(order(sid), ['Email', got.name, again.name, long])
  const short = sheet(['A', 'B'], [{ A: 1, B: 2 }])
  const b = (await del(short, 'B'))!
  assert.ok('ok' in addSheetColumn(short, uid, 'B', { seedEmptyRow: false }))
  assert.equal(((await restoreOne(b)).restored as any).name, 'B (restored)', 'a short name is as before')
})

await ok('its old place, or last when the sheet has fewer columns now', async () => {
  const sid = sheet(['A', 'B', 'C', 'D'], [{ A: 1, B: 2, C: 3, D: 4 }])
  const d = (await del(sid, 'D'))!
  await del(sid, 'A')
  assert.equal(((await restoreOne(d)).restored as any).position, 2)
  assert.deepEqual(order(sid), ['B', 'C', 'D'])
  const c = (await del(sid, 'C'))!
  const b = (await del(sid, 'D'))!
  assert.equal(((await restoreOne(b)).restored as any).position, 1, 'D was second of three: last of two')
  assert.equal(((await restoreOne(c)).restored as any).position, 1)
  assert.deepEqual(order(sid), ['B', 'C', 'D'])
})

await ok('Settings keeping 0 days: the delete is as before, nothing goes to the trash', async () => {
  setTrashDays(uid, 0)
  try {
    const sid = leads()
    const before = db.prepare('SELECT COUNT(*) FROM trash_items').pluck().get()
    assert.equal(await del(sid, 'Notes'), null)
    assert.equal(db.prepare('SELECT COUNT(*) FROM trash_items').pluck().get(), before)
    assert.deepEqual(cells(sid, 'Notes'), [null, null, null, null, null])
    assert.deepEqual(order(sid), ['Email', 'Name'])
    const line = history(sid).at(-1)!
    assert.equal(line.summary, 'Deleted the column "Notes"')
    assert.equal(line.detail, null)
  } finally { setTrashDays(uid, 30) }
})

done()
