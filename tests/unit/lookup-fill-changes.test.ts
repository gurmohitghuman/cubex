// A lookup's fill with rows written decides, each time it would go on, whether
// what it reads changed while it wasn't looking, and then looks every row up
// again from the first: a formula column it reads that filled again while it
// waited for an auto-run batch run, a run (not auto-run) that started and
// ended meanwhile, and the same two found by a restart (from the records),
// all end with every row from the new values.
import assert from 'node:assert/strict'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import colMod from '../../server/src/services/lookup-column'
const { derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const k = lookupWaitKit('lookup-fill-changes')
const { db, uid, ok, done, place, cells, statusOf, until, lookup, formula, refillFormula, fillF, fillingFrom,
  resumeLookups, rec, rowids, setCells, httpRun, endRun, runNote, oneRowASlice } = k
console.error = () => {}

const V2 = ['N0-v2', 'N1-v2', 'N2-v2'], M = ['M0', 'M1', 'M2']
const again = async (a: string, o: string, returnColumn: string) => {
  const out = await startLookupColumn(uid, a, { column: 'Who', sourceColumn: 'Email', otherSheetId: o,
    matchColumn: 'Email', returns: 'value', returnColumn })
  assert.ok('ok' in out, JSON.stringify(out))
}
// "Look up every row again", one row a slice: after its first row an auto-run batch run starts filling Email
// there (the column it matches), and it waits for that run where it was.
const waitsForABatch = async (a: string, o: string, id: string, returnColumn: string) => {
  let run = ''
  const slow = oneRowASlice(id, () => { run = httpRun(o, 'Email', true) })
  await again(a, o, returnColumn)
  await until('it waits for the run', () => derivedFillWait(id) === runNote(o, 'Email'))
  assert.equal(rec(id)!.fill_cursor, rowids(a)[0], 'after an auto-run batch run it goes on where it was')
  return { run, slow }
}

await ok('a formula column it reads that fills again while it waits for an auto-run batch run: every row again',
  async () => {
    const a = place().sid, o = place().sid
    const fid = await formula(o, '-v1')
    const id = await lookup(a, o, 'Who', 'value', 'F')
    const { run, slow } = await waitsForABatch(a, o, id, 'F')
    try {
      refillFormula(fid, '-v1', '-v2')
      await fillF(o, fid)
      endRun(run)
      await until('it is done', () => statusOf(a, 'Who') === 'done')
    } finally { slow.restore() }
    assert.deepEqual(cells(a, 'Who'), V2)
    assert.equal(rec(id)!.filled_rows, 3)
  })

await ok('a run (not auto-run) on a column it reads that starts and ends while it waits for an auto-run batch run: '
  + 'every row again', async () => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  const { run, slow } = await waitsForABatch(a, o, id, 'Name')
  try {
    // Between two of its looks: Name written, the run already over.
    setCells(o, 'Name', M)
    httpRun(o, 'Name', false, 'completed')
    endRun(run)
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  assert.deepEqual(cells(a, 'Who'), M)
})

// As a restart finds it: rows 1 and 2 written, the cursor past them; nothing in this process saw them written.
const foundAtRestart = (a: string, id: string) => {
  setCells(a, 'Who', ['old0', 'old1'])
  fillingFrom(id, rowids(a)[1], 2)
}
// The fixture's own run on Name is older than anything the lookup wrote.
const settled = (o: string) =>
  db.prepare("UPDATE ai_runs SET updated_at = datetime('now', '-1 hour') WHERE sheet_id = ?").run(o)

await ok('a restart that finds it with rows written after a formula column it reads filled again: every row again',
  async () => {
    const a = place().sid, o = place().sid
    settled(o)
    const fid = await formula(o, '-v1')
    const id = await lookup(a, o, 'Who', 'value', 'F')
    refillFormula(fid, '-v1', '-v2')
    await fillF(o, fid)
    foundAtRestart(a, id)
    resumeLookups()
    await until('it is done', () => statusOf(a, 'Who') === 'done')
    assert.deepEqual(cells(a, 'Who'), V2)
  })

await ok('a restart that finds it with rows written after a run (not auto-run) wrote a column it reads: every row '
  + 'again; after an auto-run batch run it goes on', async () => {
  for (const batch of [false, true]) {
    const a = place().sid, o = place().sid
    settled(o)
    const id = await lookup(a, o, 'Who', 'value', 'Name')
    setCells(o, 'Name', M)
    httpRun(o, 'Name', batch, 'completed')
    foundAtRestart(a, id)
    resumeLookups()
    await until('it is done', () => statusOf(a, 'Who') === 'done')
    assert.deepEqual(cells(a, 'Who'), batch ? ['old0', 'old1', 'M2'] : M, batch ? 'auto-run batch' : 'run')
  }
})

done()
