// A lookup's fill waits for a column it reads in the other sheet that a fill
// there (here a formula column) is filling, instead of failing: the column's
// view says what it waits for, and it goes on as soon as that fill ends. If it
// had written rows already, it starts over from the first row, so no row keeps
// a value from before. The wait is durable (a restart waits again, then
// fills). Starting it while that column fills is accepted and waits; "Look up
// again" while it waits fills it once; deleting it while it waits doesn't
// bring it back.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import formulaKindMod from '../../server/src/services/formula-kind'
import viewMod from '../../server/src/services/lookup-view'
import colMod from '../../server/src/services/lookup-column'
import deleteMod from '../../server/src/services/column-delete'
import helpersMod from '../../server/src/lib/sql-helpers'
const { derivedFillWait, resumeDerivedFills } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { formulaKind } = formulaKindMod as typeof import('../../server/src/services/formula-kind')
const { lookupColumnJson, lookupColumnView } = viewMod as typeof import('../../server/src/services/lookup-view')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { getSheetColumns } = helpersMod as typeof import('../../server/src/lib/sql-helpers')
const k = lookupWaitKit('lookup-fill-waits')
const { db, uid, ok, done, idle, place, cells, statusOf, until, lookup, sheetName, formula, refillFormula, fillF,
  fillingFrom, resumeLookups, rec, rowids, setCells, rowsOf } = k
console.error = () => {}

const V1 = ['N0-v1', 'N1-v1', 'N2-v1'], V2 = ['N0-v2', 'N1-v2', 'N2-v2']
// A lookup on `a` returning F of `o`, filled with F's first values; then F set to fill again.
const setUp = async () => {
  const a = place().sid, o = place().sid
  const fid = await formula(o, '-v1')
  const id = await lookup(a, o, 'Who', 'value', 'F')
  assert.deepEqual(cells(a, 'Who'), V1)
  refillFormula(fid, '-v1', '-v2')
  return { a, o, fid, id, note: `Waits for "F" in "${sheetName(o)}" to finish filling.` }
}
const passesOf = (id: string) => {
  const real = lookupKind.open
  let n = 0
  lookupKind.open = (r, use) => { if (r.id === id) n++; return real.call(lookupKind, r, use) }
  return { count: () => n, restore: () => { lookupKind.open = real } }
}

await ok('a lookup with no rows written yet waits for the column it reads to finish filling, then fills', async () => {
  const { a, o, fid, id, note } = await setUp()
  fillingFrom(id)
  resumeLookups()
  await until('it waits', () => derivedFillWait(id) === note)
  assert.equal(statusOf(a, 'Who'), 'filling')
  // What the app and agents are told.
  assert.equal(lookupColumnView(rec(id)!).waiting, note)
  assert.equal(lookupColumnJson(lookupColumnView(rec(id)!)).waiting, note)
  await fillF(o, fid)
  const ended = Date.now()
  await until('it is done', () => statusOf(a, 'Who') === 'done')
  assert.ok(Date.now() - ended < 2_000, 'it went on when the fill ended, not at its next look')
  assert.deepEqual(cells(a, 'Who'), V2)
  assert.equal(derivedFillWait(id), null)
})

await ok('a lookup that had written rows when the column started filling looks every row up again', async () => {
  const { a, o, fid, id, note } = await setUp()
  // Rows 1 and 2 written (with what F held then), the cursor past them.
  setCells(a, 'Who', ['old0', 'old1'])
  fillingFrom(id, rowids(a)[1], 2)
  resumeLookups()
  await until('it waits', () => derivedFillWait(id) === note)
  assert.equal(rec(id)!.fill_cursor, 0, 'it starts over from the first row')
  assert.equal(rec(id)!.filled_rows, 0)
  await fillF(o, fid)
  await until('it is done', () => statusOf(a, 'Who') === 'done')
  assert.deepEqual(cells(a, 'Who'), V2)
  assert.equal(rec(id)!.filled_rows, 3)
})

// The lookup's fill in another process, which stops once it waits: its waiter is lost with it.
const requireHere = createRequire(import.meta.url)
const waitThenStop = (id: string) => new Promise<void>((resolve, reject) => {
  const mod = (p: string) => JSON.stringify(requireHere.resolve(p))
  const code = `require(${mod('tsx/cjs/api')}).register();
    const { resumeDerivedFills, derivedFillWait } = require(${mod('../../server/src/services/derived-fill')});
    const { lookupKind } = require(${mod('../../server/src/services/lookup-kind')});
    resumeDerivedFills(lookupKind);
    const look = () => {
      if (derivedFillWait(${JSON.stringify(id)})) process.exit(0);
      if (lookupKind.load(${JSON.stringify(id)})?.fill_status !== 'filling') process.exit(3);
      setTimeout(look, 10);
    };
    look();`
  const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', chunk => { err += chunk })
  child.on('error', reject)
  child.on('close', c => (c === 0 ? resolve() : reject(new Error(`the fill ended instead of waiting (${c}): ${err}`))))
})

await ok('a restart while it waits keeps it filling from the first row; at boot it waits again, then fills',
  async () => {
    const { a, fid, id } = await setUp()
    setCells(a, 'Who', ['old0'])
    fillingFrom(id, rowids(a)[0], 1)
    await waitThenStop(id)
    assert.equal(statusOf(a, 'Who'), 'filling')
    assert.equal(rec(id)!.fill_cursor, 0)
    assert.equal(derivedFillWait(id), null, 'nothing waits in this process')
    // As at boot: every unfinished fill resumes, the formula's and the lookup's.
    resumeDerivedFills(formulaKind)
    resumeLookups()
    await until('both are done', () => statusOf(a, 'Who') === 'done'
      && db.prepare('SELECT fill_status FROM formula_columns WHERE id = ?').pluck().get(fid) === 'done')
    assert.deepEqual(cells(a, 'Who'), V2)
  })

await ok('starting it while the column fills is accepted and waits; "Look up again" while it waits fills it once',
  async () => {
    const { a, o, fid, id, note } = await setUp()
    const input = { column: 'Who', sourceColumn: 'Email', otherSheetId: o, matchColumn: 'Email', returns: 'value',
      returnColumn: 'F' }
    const first = await startLookupColumn(uid, a, input)
    assert.ok('ok' in first, JSON.stringify(first))
    await until('it waits', () => derivedFillWait(id) === note)
    const again = await startLookupColumn(uid, a, input)
    assert.ok('ok' in again && again.ok.id === id, JSON.stringify(again))
    await idle(a)
    assert.equal(derivedFillWait(id), note)
    const passes = passesOf(id)
    try {
      await fillF(o, fid)
      await until('it is done', () => statusOf(a, 'Who') === 'done')
      await new Promise(r => setTimeout(r, 300))
      await idle(a)
      assert.equal(passes.count(), 1, 'one pass filled it')
    } finally { passes.restore() }
    assert.deepEqual(cells(a, 'Who'), V2)
  })

await ok("a lookup deleted while it waits isn't brought back when the fill it waited for ends", async () => {
  const { a, o, fid, id, note } = await setUp()
  fillingFrom(id)
  resumeLookups()
  await until('it waits', () => derivedFillWait(id) === note)
  assert.deepEqual(await deleteSheetColumn(a, uid, 'Who'), { ok: true })
  await fillF(o, fid)
  await new Promise(r => setTimeout(r, 300))
  await idle(a)
  assert.ok(!getSheetColumns(a, uid, false).includes('Who'))
  assert.equal(rec(id), undefined)
  assert.ok(rowsOf(a).every(r => !('Who' in JSON.parse(r.data))), 'no row holds a Who cell')
  assert.equal(derivedFillWait(id), null)
})

done()
