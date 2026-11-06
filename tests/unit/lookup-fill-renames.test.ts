// A column a lookup's fill read in the other sheet that's gone from there while
// it waits, renamed or deleted, is a change: it looks every row up again from
// the first. A list of every column lists other keys then, and a value
// lookup's returned column may have filled again under its old name. (A column
// added isn't a change: lookup-fill-lists.)
import assert from 'node:assert/strict'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import colMod from '../../server/src/services/lookup-column'
import deleteMod from '../../server/src/services/column-delete'
import renameMod from '../../server/src/services/column-rename'
const { derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const k = lookupWaitKit('lookup-fill-renames')
const { uid, ok, done, place, cells, statusOf, until, lookup, formula, refillFormula, fillF, rec, rowids, httpRun,
  endRun, runNote, oneRowASlice } = k
console.error = () => {}

// "Look up every row again" (input: the lookup's column and what it returns), one row a slice: after its
// first row an auto-run batch run starts filling Email there, and it waits for that run where it was. Then
// change() there, and the run ends.
const whileItWaits = async (a: string, o: string, id: string, input: { column: string; returns: string;
  returnColumn?: string }, change: () => Promise<void>) => {
  let batch = ''
  const slow = oneRowASlice(id, () => { batch = httpRun(o, 'Email', true) })
  try {
    const out = await startLookupColumn(uid, a, { sourceColumn: 'Email', otherSheetId: o, matchColumn: 'Email',
      ...input })
    assert.ok('ok' in out, JSON.stringify(out))
    await until('it waits for the batch run', () => derivedFillWait(id) === runNote(o, 'Email'))
    assert.equal(rec(id)!.fill_cursor, rowids(a)[0], 'it waits where it was')
    await change()
    endRun(batch)
    await until('it is done', () => statusOf(a, input.column) === 'done')
  } finally { slow.restore() }
}
const changed = (out: object) => assert.ok('ok' in out && out.ok, JSON.stringify(out))
const keysOf = (cell: string | undefined) => Object.keys(JSON.parse(cell ?? '[]')[0] ?? {}).join()

await ok('a list of every column, a column there deleted or renamed while it waits: every row again', async () => {
  for (const how of ['deleted', 'renamed'] as const) {
    const a = place().sid, o = place().sid
    const id = await lookup(a, o, 'All', 'list')
    await whileItWaits(a, o, id, { column: 'All', returns: 'list' }, async () => {
      changed(how === 'deleted' ? await deleteSheetColumn(o, uid, 'Name')
        : await renameSheetColumn(o, uid, 'Name', 'Full name'))
    })
    const keys = how === 'deleted' ? 'Email' : 'Email,Full name'
    assert.deepEqual(cells(a, 'All').map(keysOf), [keys, keys, keys], how)
  }
})

await ok('a value lookup whose returned formula column fills again and is then renamed while it waits: every row '
  + 'again', async () => {
  const a = place().sid, o = place().sid
  const fid = await formula(o, '-v1')
  const id = await lookup(a, o, 'Who', 'value', 'F')
  await whileItWaits(a, o, id, { column: 'Who', returns: 'value', returnColumn: 'F' }, async () => {
    refillFormula(fid, '-v1', '-v2')
    await fillF(o, fid)
    changed(await renameSheetColumn(o, uid, 'F', 'G'))
  })
  assert.equal(rec(id)!.return_columns, JSON.stringify(['G']))
  assert.deepEqual(cells(a, 'Who'), ['N0-v2', 'N1-v2', 'N2-v2'])
})

done()
