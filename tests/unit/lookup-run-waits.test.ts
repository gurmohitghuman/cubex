// A lookup's fill that had written rows when a run started filling a column it
// reads waits for the run, then looks every row up again from the first, so
// no row keeps a value from before the run; its cursor is back at the first
// row while it waits. After a run auto-run started for a batch of rows (a
// sheet fed by webhooks starts one per batch) it goes on where it was.
// Starting a lookup while such a run is going is refused.
import assert from 'node:assert/strict'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import colMod from '../../server/src/services/lookup-column'
const { derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const k = lookupWaitKit('lookup-run-waits')
const { uid, ok, done, place, cells, statusOf, until, lookup, sheetName, rec, rowids, setCells, httpRun, endRun,
  runNote, oneRowASlice } = k
console.error = () => {}

const M = ['M0', 'M1', 'M2']
const input = (o: string) => ({ column: 'Who', sourceColumn: 'Email', otherSheetId: o, matchColumn: 'Email',
  returns: 'value', returnColumn: 'Name' })

// "Look up every row again", one row a slice; after its first row a run starts writing Name there, which the
// lookup returns. The run writes M into Name, then ends.
const runDuringFill = async (batch: boolean, whileWaiting: (a: string, o: string, id: string) => void) => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  let run = ''
  const slow = oneRowASlice(id, () => { run = httpRun(o, 'Name', batch) })
  try {
    const out = await startLookupColumn(uid, a, input(o))
    assert.ok('ok' in out, JSON.stringify(out))
    await until('it waits for the run', () => derivedFillWait(id) === runNote(o, 'Name'))
    whileWaiting(a, o, id)
    setCells(o, 'Name', M)
    endRun(run)
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  return { a, id }
}

await ok('a run on a column it reads, after it wrote a row: it waits from the first row, then every row is new',
  async () => {
    const { a, id } = await runDuringFill(false, (a, o, id) => {
      assert.equal(rec(id)!.fill_cursor, 0, 'its cursor is back at the first row')
      assert.equal(rec(id)!.filled_rows, 0)
      assert.equal(statusOf(a, 'Who'), 'filling')
    })
    assert.deepEqual(cells(a, 'Who'), M)
    assert.equal(rec(id)!.filled_rows, 3)
  })

await ok('an auto-run batch run on a column it reads, after it wrote a row: it waits where it was, then goes on',
  async () => {
    const { a } = await runDuringFill(true, (a, o, id) => {
      assert.equal(rec(id)!.fill_cursor, rowids(a)[0], 'it keeps its place')
    })
    assert.deepEqual(cells(a, 'Who'), ['N0', 'M1', 'M2'])
  })

await ok('starting a lookup while a run fills a column it reads is refused, an auto-run batch run too', async () => {
  for (const batch of [false, true]) {
    const a = place().sid, o = place().sid
    const run = httpRun(o, 'Name', batch)
    const out = await startLookupColumn(uid, a, input(o))
    assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
    assert.equal(out.message, `"Name" in "${sheetName(o)}" is still being filled. Look up once it's done.`)
    endRun(run)
  }
})

done()
