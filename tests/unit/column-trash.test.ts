// Over 200 lines: one fixture and the delete and restore of a plain column, case by case.
// A deleted column goes to the trash (migration 054: services/column-trash.ts, lib/trash/column-move.ts,
// services/trash-restore-column.ts). Pins: the delete makes one 'column' item holding only the cells that had
// a value (row id, place), its place, description and setup, and leaves the rows as a delete always did;
// Settings keeping 0 days deletes it at once with no item; restore puts it back at its place under its name, or
// "<name> (restored)", "(restored 2)" when a column has it now (in any case), its cells on the rows still
// there (skipped: rows gone; kept: a row holding a value there now); refusals (a run, a busy sheet, the column
// limit, its sheet in the trash, seqs) with their words; a sheet's purge takes its column items; and rows
// deleted before their column come back into it when the column is restored first, else beside it.
import assert from 'node:assert/strict'
import storeMod from '../../server/src/lib/trash/store'
import busyMod from '../../server/src/lib/sheet-busy'
import addMod from '../../server/src/services/column-add'
import sheetsMod from '../../server/src/services/trash-sheets'
import purgeMod from '../../server/src/services/trash-purge'
import readMod from '../../server/src/services/trash-read'
import rowsMod from '../../server/src/services/trash-rows'
import restoreRowsMod from '../../server/src/services/trash-restore'
import descMod from '../../server/src/lib/column-descriptions'
import constMod from '../../server/src/lib/constants'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
const { setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
const { trashSheet } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')
const { getTrashEntry, readTrashRows } = readMod as typeof import('../../server/src/services/trash-read')
const { deleteRowsToTrash } = rowsMod as typeof import('../../server/src/services/trash-rows')
const { restoreRows } = restoreRowsMod as typeof import('../../server/src/services/trash-restore')
const { sheetColumnDescriptions, writeColumnDescription } = descMod as
  typeof import('../../server/src/lib/column-descriptions')
const { MAX_COLUMNS_PER_SHEET, TRASH_RESTORE_WAIT_ROWS } = constMod as typeof import('../../server/src/lib/constants')
const k = columnTrashKit('column-trash')
const { db, uid, tid, ok, done, idle, sheet, order, cells, item, stored, del, restore, restoreOne, history } = k

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
    [`r0-${sid}`, 0, { Notes: 'first' }], [`r3-${sid}`, 3, { Notes: { deep: [1, 2] } }], [`r4-${sid}`, 4, { Notes: 42 }],
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
    references_dropped: [] })
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

await ok('rows deleted after their column: restored later, the leftover cells go into the column', async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  const rows = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0, 4] }))().trashId!
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual([got.name, got.cells_restored, got.cells_skipped], ['Notes', 1, 2])
  assert.equal(getTrashEntry(uid, id)!.note, 'Its other cells went back to "Notes" when their rows were gone: '
    + 'restored once those rows are back, these go into it too.')
  assert.ok('ok' in await restoreRows(uid, rows))
  await idle(sid)
  const rest = (await restoreOne(id)).restored as any
  assert.deepEqual([rest.name, rest.renamed, rest.cells_restored, rest.cells_skipped, rest.position],
    ['Notes', false, 2, 0, 1])
  assert.equal(rest.setup.note, 'Its setup came back with "Notes" already.')
  assert.deepEqual(rest.references_dropped, [])
  assert.equal(rest.note, 'These cells\' rows were gone when "Notes" came back; they went into it now.')
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

await ok('a cell that holds a value now under the name it gets is never overwritten', async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  // Something wrote under the old name meanwhile, without listing it (the column is still gone).
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Notes', 'newer') WHERE id = ?`).run(`r3-${sid}`)
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual([got.cells_restored, got.cells_skipped, got.cells_kept], [2, 0, 1])
  assert.deepEqual(cells(sid, 'Notes'), ['first', null, null, 'newer', 42])
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

await ok('refusals: a run on the sheet, a busy sheet, the column limit, its sheet in the trash, seqs', async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Name')`).run(run, sid, uid)
  const active = await restoreOne(id)
  assert.equal(active.fail, 'conflict')
  assert.equal(active.error, 'Cannot restore a column while a run is active on this sheet. Stop or finish the run first.')
  assert.deepEqual(active.blocking_run, { id: run, kind: 'http', column: 'Name', paused: false })
  db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(run)
  let release!: () => void
  const held = withSheetBusy(sid, 'sorting', () => new Promise<void>(r => { release = r }))
  const busy = await restoreOne(id)
  assert.deepEqual([busy.fail, busy.error, busy.busy], ['conflict', 'This sheet is busy sorting. Try again when that '
    + 'finishes.', true])
  release(); await held
  assert.equal(item(id)!.state, 'kept', 'a refused restore leaves the item as it was')
  const full = Array.from({ length: MAX_COLUMNS_PER_SHEET }, (_, i) => `C${i}`)
  const saved = order(sid)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(full), sid)
  const cap = await restoreOne(id)
  assert.deepEqual([cap.fail, cap.error], ['bad_request', `The sheet has ${MAX_COLUMNS_PER_SHEET} columns, the most `
    + 'it can hold. Delete a column, then restore "Notes".'])
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(saved), sid)
  const picked = await restoreRows(uid, id, [1])
  assert.deepEqual(picked, { fail: 'bad_request', message: 'A column comes back whole: restore it without seqs.' })
  const other = leads()
  assert.ok('ok' in trashSheet(uid, tid, other))
  const gone = sheet(['X', 'Y'], [{ X: 1, Y: 2 }])
  const inTrash = (await del(gone, 'Y'))!
  const sheetItem = trashSheet(uid, tid, gone)
  assert.ok('ok' in sheetItem)
  const waits = await restoreOne(inTrash)
  const sheetName = db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(gone)
  assert.deepEqual([waits.fail, waits.error], ['conflict', `Its sheet "${sheetName}" is in the trash. Restore the `
    + 'sheet first.'])
  assert.equal(getTrashEntry(uid, inTrash)!.blocked, `Its sheet "${sheetName}" is in the trash: restore the sheet first.`)
  assert.ok((await restoreOne(id)).restored, 'once free, it restores')
})

await ok("a sheet's purge takes its column items and their cells", async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  assert.equal(item(id)!.state, 'kept')
  assert.equal(stored(id).length, 3)
  const out = trashSheet(uid, tid, sid)
  assert.ok('ok' in out)
  const sheetItem = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND kind = 'sheet'`).pluck().get(sid) as
    number
  purgeTrashItems(uid, [sheetItem])
  for (let i = 0; i < 300 && item(sheetItem); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(item(sheetItem), undefined)
  assert.equal(item(id), undefined)
  assert.equal(stored(id).length, 0)
  const lone = leads()
  const alone = (await del(lone, 'Notes'))!
  assert.equal(stored(alone).length, 3)
  purgeTrashItems(uid, [alone])
  for (let i = 0; i < 300 && item(alone); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(item(alone), undefined)
  assert.equal(stored(alone).length, 0)
  assert.deepEqual(order(lone), ['Email', 'Name'])
})

// Rows 0 and 1 deleted (a batch holding their Notes), then the column (the rest of its cells).
async function rowsThenColumn() {
  const sid = leads()
  writeColumnDescription(sid, uid, 'Notes', 'Kept notes')
  const rows = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0, 3] }))().trashId!
  const column = (await del(sid, 'Notes'))!
  return { sid, rows, column }
}

await ok('rows deleted before their column: restored first they add it back plain, and it comes back beside', async () => {
  const { sid, rows, column } = await rowsThenColumn()
  const r = await restoreRows(uid, rows)
  assert.ok('ok' in r && r.ok.columns_added.join() === 'Notes')
  await idle(sid)
  const got = (await restoreOne(column)).restored as any
  assert.equal(got.name, 'Notes (restored)')
  assert.deepEqual(order(sid), ['Email', 'Notes (restored)', 'Name', 'Notes'])
  assert.equal(sheetColumnDescriptions(sid, uid).get('Notes (restored)'), 'Kept notes')
  const all = db.prepare(`SELECT id, json_extract(data, '$.Notes') AS a, json_extract(data, '$."Notes (restored)"') AS b
    FROM rows WHERE sheet_id = ? ORDER BY id`).all(sid)
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

done()
