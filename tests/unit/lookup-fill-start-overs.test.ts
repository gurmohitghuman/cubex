// A lookup's fill starts over at most 3 times for what it reads changing
// (LOOKUP_FILL_START_OVERS). At the 4th change it goes on where it was, and
// its note names the column that kept changing, or the rows, for the app and
// agents (get_sheet, lookup_column), also once the fill is done, as the column
// and sheet are called now. A new start ("Look up every row again", or a
// restore filling it again) counts from 0 again, without the note.
import assert from 'node:assert/strict'
import { lookupWaitKit } from './lookup-wait-kit'
import colMod from '../../server/src/services/lookup-column'
import viewMod from '../../server/src/services/lookup-view'
import readMod from '../../server/src/services/workspace-read'
import constMod from '../../server/src/lib/constants'
import actionsMod from '../../server/src/services/trash-actions'
import renameMod from '../../server/src/services/column-rename'
import sheetMod from '../../server/src/services/sheet-crud'
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { lookupColumnView } = viewMod as typeof import('../../server/src/services/lookup-view')
const { getSheetMeta } = readMod as typeof import('../../server/src/services/workspace-read')
const { LOOKUP_FILL_START_OVERS } = constMod as typeof import('../../server/src/lib/constants')
const { restoreFromTrash } = actionsMod as typeof import('../../server/src/services/trash-actions')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { renameSheet } = sheetMod as typeof import('../../server/src/services/sheet-crud')
const k = lookupWaitKit('lookup-fill-start-overs')
const { db, uid, ok, done, place, cells, statusOf, until, lookup, sheetName, rec, setCells, httpRun, oneRowASlice,
  failedOnTrash } = k
console.error = () => {}

const values = (n: number) => [0, 1, 2].map(i => `V${n}-${i}`)
// Name there changes to values(n), by a run (not auto-run) that already ended.
const change = (o: string) => (n: number) => {
  setCells(o, 'Name', values(n))
  httpRun(o, 'Name', false, 'completed')
}
// "Look up every row again", one row a slice; after each of its first `times` rows, Name there changes
// (or after(n)).
const lookUpAgain = async (a: string, o: string, id: string, times: number, first: number,
  after = (n: number) => change(o)(first + n - 1)) => {
  const slow = oneRowASlice(id, after, times)
  try {
    const out = await startLookupColumn(uid, a, { column: 'Who', sourceColumn: 'Email', otherSheetId: o,
      matchColumn: 'Email', returns: 'value', returnColumn: 'Name' })
    assert.ok('ok' in out, JSON.stringify(out))
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
}

const a = place().sid, other = place(), o = other.sid
const id = await lookup(a, o, 'Who', 'value', 'Name')
const MAY = 'may hold older values. Look up every row again to redo them.'
const named = (column: string, sheet: string) =>
  `"${column}" in "${sheet}" kept changing, so rows looked up before its last change ${MAY}`
const note = named('Name', sheetName(o))

await ok('the 4th change goes on where it was, and says which column kept changing', async () => {
  assert.equal(LOOKUP_FILL_START_OVERS, 3)
  await lookUpAgain(a, o, id, 4, 1)
  // It started over after changes 1 to 3; row 1 is from the 3rd change's values, the rest from the 4th.
  assert.deepEqual(cells(a, 'Who'), ['V3-0', 'V4-1', 'V4-2'])
  assert.equal(rec(id)!.filled_rows, 3)
  // Kept once the fill is done, for the app and agents.
  const view = lookupColumnView(rec(id)!)
  assert.equal(view.status, 'done')
  assert.equal(view.keptChanging, note)
  const listed = getSheetMeta(a, uid)!.lookup_columns.find(l => l.column === 'Who')
  assert.equal(listed?.kept_changing, note, 'get_sheet lists it')
})

await ok('the note names the column and the sheet as they are called now', async () => {
  const tableOf = db.prepare('SELECT table_id FROM sheets WHERE id = ?').pluck().get(o) as string
  const was = sheetName(o)
  try {
    const renamed = await renameSheetColumn(o, uid, 'Name', 'Full name')
    assert.ok('ok' in renamed, JSON.stringify(renamed))
    assert.ok('ok' in renameSheet(uid, tableOf, o, 'People now'))
    assert.equal(lookupColumnView(rec(id)!).keptChanging, named('Full name', 'People now'))
  } finally {
    // Back, for the cases after.
    assert.ok('ok' in await renameSheetColumn(o, uid, 'Full name', 'Name'))
    assert.ok('ok' in renameSheet(uid, tableOf, o, was))
  }
  assert.equal(lookupColumnView(rec(id)!).keptChanging, note)
})

await ok('rows there that kept moving: the note says so', async () => {
  const a2 = place().sid, o2 = place().sid
  const id2 = await lookup(a2, o2, 'Who', 'value', 'Name')
  // After each of its first 4 rows, the rows there move (as a sort, a replace by an import or removing
  // duplicates does: the sheet's row_generation).
  await lookUpAgain(a2, o2, id2, 4, 1,
    () => db.prepare('UPDATE sheets SET row_generation = row_generation + 1 WHERE id = ?').run(o2))
  assert.equal(lookupColumnView(rec(id2)!).keptChanging, `The rows of "${sheetName(o2)}" kept changing (sorted, `
    + `replaced by an import or duplicates removed), so rows looked up before the last change ${MAY}`)
})

await ok('a new start counts from 0 again, without the note', async () => {
  await lookUpAgain(a, o, id, 1, 5)
  assert.deepEqual(cells(a, 'Who'), values(5), 'it started over after the change')
  assert.equal(lookupColumnView(rec(id)!).keptChanging, null)
  assert.equal(getSheetMeta(a, uid)!.lookup_columns.find(l => l.column === 'Who')?.kept_changing, undefined)
})

await ok('a restore that fills it again counts from 0 again, without the note', async () => {
  await lookUpAgain(a, o, id, 4, 6)
  assert.equal(lookupColumnView(rec(id)!).keptChanging, note)
  // The sheet it looks in goes to the trash, and its fill fails there; restored, the lookup fills again.
  const item = await failedOnTrash(a, other)
  assert.equal(lookupColumnView(rec(id)!).keptChanging, note, 'kept once the fill ended')
  const out = await restoreFromTrash(uid, [item])
  assert.ok(out[0].restored, JSON.stringify(out[0]))
  await until('it is done', () => statusOf(a, 'Who') === 'done')
  assert.equal(lookupColumnView(rec(id)!).keptChanging, null)
})

done()
