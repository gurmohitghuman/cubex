// A lookup's fill starts over at most 3 times for what it reads changing
// (LOOKUP_FILL_START_OVERS). At the 4th change it goes on where it was, and
// its note names the column that kept changing, for the app and agents
// (get_sheet, lookup_column), also once the fill is done. A new start ("Look
// up again", or a restore filling it again) counts from 0 again, without the
// note.
import assert from 'node:assert/strict'
import { lookupWaitKit } from './lookup-wait-kit'
import colMod from '../../server/src/services/lookup-column'
import viewMod from '../../server/src/services/lookup-view'
import readMod from '../../server/src/services/workspace-read'
import constMod from '../../server/src/lib/constants'
import actionsMod from '../../server/src/services/trash-actions'
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { lookupColumnView } = viewMod as typeof import('../../server/src/services/lookup-view')
const { getSheetMeta } = readMod as typeof import('../../server/src/services/workspace-read')
const { LOOKUP_FILL_START_OVERS } = constMod as typeof import('../../server/src/lib/constants')
const { restoreFromTrash } = actionsMod as typeof import('../../server/src/services/trash-actions')
const k = lookupWaitKit('lookup-fill-start-overs')
const { uid, ok, done, place, cells, statusOf, until, lookup, sheetName, rec, setCells, httpRun, oneRowASlice,
  failedOnTrash } = k
console.error = () => {}

const values = (n: number) => [0, 1, 2].map(i => `V${n}-${i}`)
// Name there changes to values(n), by a run (not auto-run) that already ended.
const change = (o: string) => (n: number) => {
  setCells(o, 'Name', values(n))
  httpRun(o, 'Name', false, 'completed')
}
// "Look up every row again", one row a slice; after each of its first `times` rows, Name there changes.
const lookUpAgain = async (a: string, o: string, id: string, times: number, first: number) => {
  const slow = oneRowASlice(id, n => change(o)(first + n - 1), times)
  try {
    const out = await startLookupColumn(uid, a, { column: 'Who', sourceColumn: 'Email', otherSheetId: o,
      matchColumn: 'Email', returns: 'value', returnColumn: 'Name' })
    assert.ok('ok' in out, JSON.stringify(out))
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
}

const a = place().sid, other = place(), o = other.sid
const id = await lookup(a, o, 'Who', 'value', 'Name')
const note = `"Name" in "${sheetName(o)}" kept changing, so rows looked up before its last change may hold older `
  + 'values. Look up again to redo them.'

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
