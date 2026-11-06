// What a restore starts again (trash-restore-sheet.ts startRestored) waits for
// the whole request that restored: a fill parked while its sheet was in the
// trash, and the lookups set to fill again, go on after it, so no batch of rows
// restored in the same request is refused as busy, even one restored after
// another sheet's batch (whose slices let other work in). And every lookup
// into the restored sheet whose fill failed while it was in the trash fills
// again, two on one sheet one after another. A lookup reading a formula column
// that the same restore resumes waits for it, then fills.
import assert from 'node:assert/strict'
import { IN_TRASH } from './trash-refill-kit'
import { lookupWaitKit } from './lookup-wait-kit'
import actionsMod from '../../server/src/services/trash-actions'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import busyMod from '../../server/src/lib/sheet-busy'
import formulaKindMod from '../../server/src/services/formula-kind'
const { restoreFromTrash } = actionsMod as typeof import('../../server/src/services/trash-actions')
const { derivedFillWait, resumeDerivedFills } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { sheetBusyWith, withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { formulaKind, FORMULA_FILLING } = formulaKindMod as typeof import('../../server/src/services/formula-kind')
const k = lookupWaitKit('trash-restore-refill')
const { uid, ok, done, idle, del, place, trash, cells, statusOf, until, lookup, refilling, failedOnTrash } = k
console.error = () => {}

// A sheet whose lookup's fill is parked while it is in the trash, with a batch of its rows in the trash too.
const parkedWithRows = async (how: 'sheet' | 'table') => {
  const p = place()
  const id = await lookup(p.sid, place().sid, 'Found', 'exists')
  const rows = del(p.sid, [2])
  assert.ok(rows.trashId, 'a batch of rows went to the trash')
  refilling(p.sid)
  const item = trash(how, p)
  resumeDerivedFills(lookupKind)
  await until('the fill is parked', () => derivedFillWait(id) === IN_TRASH)
  await idle(p.sid)
  return { p, id, item, rows: rows.trashId! }
}

for (const how of ['sheet', 'table'] as const) {
  await ok(`restoring a ${how} with a parked fill, then a batch of the sheet's rows in one request, restores both`,
    async () => {
      const { p, id, item, rows } = await parkedWithRows(how)
      // In the order the Trash page sends them: the sheet (or table) first, then its rows.
      const out = await restoreFromTrash(uid, [item, rows])
      assert.ok(out[0].restored, JSON.stringify(out[0]))
      assert.ok(out[1].restored, `the rows restore isn't refused: ${JSON.stringify(out[1])}`)
      await until('the fill is done', () => statusOf(p.sid, 'Found') === 'done')
      assert.equal(derivedFillWait(id), null)
      assert.deepEqual(cells(p.sid, 'Found'), ['Yes', 'Yes', 'Yes'])
    })
}

await ok("a sheet with a parked fill, another sheet's rows, then the first sheet's rows: all three are restored",
  async () => {
    const { p, item, rows } = await parkedWithRows('sheet')
    const y = place().sid
    const yRows = del(y, [0])
    assert.ok(yRows.trashId)
    const out = await restoreFromTrash(uid, [item, yRows.trashId!, rows])
    for (const r of out) assert.ok(r.restored, `not refused: ${JSON.stringify(r)}`)
    await until('the fill is done', () => statusOf(p.sid, 'Found') === 'done')
    assert.deepEqual(cells(p.sid, 'Found'), ['Yes', 'Yes', 'Yes'])
  })

await ok('two lookups on one sheet that failed while the sheet they read was in the trash both fill again, and a '
  + "batch of that sheet's rows restored in the same request isn't refused", async () => {
  const a = place().sid
  const other = place()
  await lookup(a, other.sid, 'Found', 'exists')
  await lookup(a, other.sid, 'Count', 'count')
  const rows = del(a, [2])
  assert.ok(rows.trashId)
  const item = await failedOnTrash(a, other)
  const out = await restoreFromTrash(uid, [item, rows.trashId!])
  assert.ok(out[0].restored, JSON.stringify(out[0]))
  assert.ok(out[1].restored, `the rows restore isn't refused: ${JSON.stringify(out[1])}`)
  // Nothing took their sheet inside the request; both are set to fill again for good.
  assert.equal(sheetBusyWith(a), null)
  assert.deepEqual([statusOf(a, 'Found'), statusOf(a, 'Count')], ['filling', 'filling'])
  await until('both are done', () => statusOf(a, 'Found') === 'done' && statusOf(a, 'Count') === 'done')
  // The restored row is looked up in the same fill.
  assert.deepEqual(cells(a, 'Found'), ['Yes', 'Yes', 'Yes'])
  assert.ok(cells(a, 'Count').every(c => c !== undefined && c !== ''), JSON.stringify(cells(a, 'Count')))
})

await ok('a lookup on a restored table reading a formula column there that the same restore resumes waits for '
  + "it, then fills (it doesn't fail)", async () => {
  const p = place()
  const o = k.fixture(3, ['Email', 'Name'], p.table)
  const fid = await k.formula(o, '-v1')
  const id = await lookup(p.sid, o, 'Who', 'value', 'F')
  // Both fill again when the table goes to the trash, and both are parked there.
  k.refillFormula(fid, '-v1', '-v2')
  k.fillingFrom(id)
  const item = trash('table', p)
  resumeDerivedFills(formulaKind)
  resumeDerivedFills(lookupKind)
  await until('both are parked', () => derivedFillWait(fid) === IN_TRASH && derivedFillWait(id) === IN_TRASH)
  // The formula's sheet taken for a moment (as by another fill), so the lookup surely looks first.
  let release!: () => void
  const held = withSheetBusy(o, FORMULA_FILLING, () => new Promise<void>(r => { release = r }))
  const out = await restoreFromTrash(uid, [item])
  assert.ok(out[0].restored, JSON.stringify(out[0]))
  await until('the lookup waits for the formula', () =>
    derivedFillWait(id) === `Waits for "F" in "${k.sheetName(o)}" to finish filling.`)
  release()
  await held
  await until('the lookup is done', () => statusOf(p.sid, 'Who') === 'done')
  assert.deepEqual(cells(p.sid, 'Who'), ['N0-v2', 'N1-v2', 'N2-v2'])
})

done()
