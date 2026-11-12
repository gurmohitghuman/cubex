// A lookup's fill with rows written looks every row up again from the first
// when, while it waited, a run that wrote a column it reads was undone in the
// other sheet (the undo counts as a fill of each of its columns), or that
// sheet's rows moved (a sort, as an import, its undo or removing duplicates
// would: the sheet's row_generation), so no row keeps a value from before.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import colMod from '../../server/src/services/lookup-column'
import undoMod from '../../server/src/services/run-undo'
import sortMod from '../../server/src/services/sheet-sort'
import writeMod from '../../server/src/lib/run-cells-write'
const { derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { undoRun } = undoMod as typeof import('../../server/src/services/run-undo')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { writeRunCells } = writeMod as typeof import('../../server/src/lib/run-cells-write')
const k = lookupWaitKit('lookup-fill-undo-sort')
const { db, uid, ok, done, place, cells, statusOf, until, lookup, rec, rowids, httpRun, endRun, runNote,
  oneRowASlice } = k
console.error = () => {}

const again = async (a: string, o: string) => {
  const out = await startLookupColumn(uid, a, { column: 'Who', sourceColumn: 'Email', otherSheetId: o,
    matchColumn: 'Email', returns: 'value', returnColumn: 'Name' })
  assert.ok('ok' in out, JSON.stringify(out))
}

await ok('a run on a column it reads undone while it waits for an auto-run batch run: every row again', async () => {
  const a = place().sid, o = place().sid
  // A run wrote M into Name there, as runs write (its journal keeps N0..N2).
  const written = httpRun(o, 'Name', false)
  db.transaction(() => [0, 1, 2].forEach(i => writeRunCells({ kind: 'http', id: written }, o, uid, i * 2,
    [['Name', `M${i}`]]))).immediate()
  endRun(written)
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  assert.deepEqual(cells(a, 'Who'), ['M0', 'M1', 'M2'])
  let batch = ''
  const slow = oneRowASlice(id, () => { batch = httpRun(o, 'Email', true) })
  try {
    await again(a, o)
    await until('it waits for the batch run', () => derivedFillWait(id) === runNote(o, 'Email'))
    assert.equal(rec(id)!.fill_cursor, rowids(a)[0])
    const undone = await undoRun(uid, 'http', written)
    assert.ok('ok' in undone, JSON.stringify(undone))
    await until('Name is back', () => cells(o, 'Name').join() === 'N0,N1,N2')
    endRun(batch)
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  assert.deepEqual(cells(a, 'Who'), ['N0', 'N1', 'N2'])
})

await ok('the other sheet sorted while it fills: every row again, from the new first matches', async () => {
  const a = place().sid, o = place().sid
  // A second row for each value, below: sorted by Name, Z to A, it comes first.
  const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  for (const i of [0, 1, 2]) ins.run(uuid(), o, uid, 6 + i * 2, JSON.stringify({ Email: `u${i}@a.com`, Name: `X${i}` }))
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  assert.deepEqual(cells(a, 'Who'), ['N0', 'N1', 'N2'])
  let sorted: Promise<unknown> = Promise.resolve()
  const slow = oneRowASlice(id, () => { sorted = physicalSortSheet(o, uid, 'Name', 'desc') })
  try {
    await again(a, o)
    const out = await sorted
    assert.ok(!(out as object | undefined) || !('fail' in (out as object)), JSON.stringify(out))
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  assert.deepEqual(cells(a, 'Who'), ['X0', 'X1', 'X2'])
})

done()
