// Lookups that would wait for each other in a loop (each reads a column the
// next one is filling, back to the first) fail, each saying which columns of
// which sheets, instead of waiting forever: two of them, three, and one held
// before its fill (as when it waits for its sheet) while the other, which
// reads it, looks. Looked up again one at a time, they fill. Starting one that
// would wait for a fill that itself waits for it is refused, and that one goes
// on.
import assert from 'node:assert/strict'
import { lookupWaitKit } from './lookup-wait-kit'
import colMod from '../../server/src/services/lookup-column'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import busyMod from '../../server/src/lib/sheet-busy'
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { runDerivedFill } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind, LOOKUP_FILLING } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const k = lookupWaitKit('lookup-fill-loops')
const { uid, ok, done, idle, place, cells, statusOf, until, lookup, sheetName, fillingFrom, resumeLookups, rec } = k
console.error = () => {}

const input = (column: string, other: string, returnColumn: string) => ({
  column, sourceColumn: 'Email', otherSheetId: other, matchColumn: 'Email', returns: 'value', returnColumn,
})
// Lookups on these sheets, each returning the next one's column, the last the first's: made one by one
// (the first reads Name until the loop is closed), all filled.
const loopOf = async (sheets: string[]) => {
  const cols = sheets.map((_, i) => `L${i}`)
  const ids: string[] = []
  for (let i = sheets.length - 1; i >= 0; i--) {
    const next = (i + 1) % sheets.length
    ids[i] = await lookup(sheets[i], sheets[next], cols[i], 'value', i === sheets.length - 1 ? 'Name' : cols[next])
  }
  const last = sheets.length - 1
  const closed = await startLookupColumn(uid, sheets[last], input(cols[last], sheets[0], cols[0]))
  assert.ok('ok' in closed, JSON.stringify(closed))
  await until('the last is done', () => statusOf(sheets[last], cols[last]) === 'done')
  await idle(sheets[last])
  return { cols, ids }
}
const at = (sid: string, col: string) => `"${col}" in "${sheetName(sid)}"`
const errorOf = (id: string) => rec(id)!.error_message ?? ''

await ok('two lookups that read each other, both filling, fail naming both columns and sheets', async () => {
  const s = [place().sid, place().sid]
  const { cols, ids } = await loopOf(s)
  ids.forEach(id => fillingFrom(id))
  resumeLookups()
  await until('both fail', () => ids.every(id => rec(id)!.fill_status === 'failed'))
  const words = (i: number, j: number) => `${at(s[i], cols[i])} waits for ${at(s[j], cols[j])} to finish filling, `
    + `and ${at(s[j], cols[j])} waits for ${at(s[i], cols[i])}: neither can finish. Look them up again one at a time.`
  assert.equal(errorOf(ids[0]), words(0, 1))
  assert.equal(errorOf(ids[1]), words(1, 0))
  // One at a time, they fill.
  for (const i of [0, 1]) {
    const again = await startLookupColumn(uid, s[i], input(cols[i], s[1 - i], cols[1 - i]))
    assert.ok('ok' in again, JSON.stringify(again))
    await until(`${cols[i]} is done`, () => statusOf(s[i], cols[i]) === 'done')
    await idle(s[i])
  }
})

await ok('three lookups in a loop, all filling, fail naming every column and sheet', async () => {
  const s = [place().sid, place().sid, place().sid]
  const { cols, ids } = await loopOf(s)
  ids.forEach(id => fillingFrom(id))
  resumeLookups()
  await until('all fail', () => ids.every(id => rec(id)!.fill_status === 'failed'))
  const n = (i: number) => at(s[i % 3], cols[i % 3])
  ids.forEach((id, i) => assert.equal(errorOf(id), `${n(i)} waits for ${n(i + 1)} to finish filling, `
    + `${n(i + 1)} for ${n(i + 2)}, and ${n(i + 2)} for ${n(i)}: none of them can finish. `
    + 'Look them up again one at a time.'))
})

await ok("a lookup whose fill is held while the one reading it looks: both fail, and the held one writes nothing",
  async () => {
    const s = [place().sid, place().sid]
    const { cols, ids } = await loopOf(s)
    const before = cells(s[0], cols[0])
    fillingFrom(ids[0])
    fillingFrom(ids[1])
    // L0's fill can't start yet (its sheet is taken); L1, reading L0, looks first.
    let release!: () => void
    const held = withSheetBusy(s[0], LOOKUP_FILLING, () => new Promise<void>(r => { release = r }))
    void withSheetBusy(s[1], LOOKUP_FILLING, () => runDerivedFill(lookupKind, ids[1]))
    await until('both fail', () => ids.every(id => rec(id)!.fill_status === 'failed'))
    release()
    await held
    await withSheetBusy(s[0], LOOKUP_FILLING, () => runDerivedFill(lookupKind, ids[0]))
    assert.deepEqual(cells(s[0], cols[0]), before)
    assert.match(errorOf(ids[0]), /neither can finish/)
  })

await ok('looking up again one that would wait for a fill that itself waits for it is refused; that fill goes on',
  async () => {
    const s = [place().sid, place().sid]
    const { cols, ids } = await loopOf(s)
    fillingFrom(ids[1]) // L1 fills (reading L0); its fill hasn't looked yet
    const out = await startLookupColumn(uid, s[0], input(cols[0], s[1], cols[1]))
    assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
    assert.equal(out.message, `${at(s[0], cols[0])} would wait for ${at(s[1], cols[1])} to finish filling, and `
      + `${at(s[1], cols[1])} waits for ${at(s[0], cols[0])}: neither could finish. `
      + `Look up once ${at(s[1], cols[1])} is done.`)
    assert.equal(rec(ids[0])!.fill_status, 'done', 'nothing changed')
    resumeLookups()
    await until('L1 is done', () => statusOf(s[1], cols[1]) === 'done')
    await idle(s[1])
    const now = await startLookupColumn(uid, s[0], input(cols[0], s[1], cols[1]))
    assert.ok('ok' in now, JSON.stringify(now))
    await until('L0 is done', () => statusOf(s[0], cols[0]) === 'done')
    await idle(s[0])
  })

done()
