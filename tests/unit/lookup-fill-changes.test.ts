// A lookup's fill with rows written decides, each time it would go on, whether
// what it reads changed while it wasn't looking, and then looks every row up
// again from the first: a formula column it reads that filled again while it
// waited for an auto-run batch run, a run (not auto-run) that started and
// ended meanwhile, a paused run that went on (found at the next look, or
// ending the batch wait at once; a cancel isn't a change), a run whose rowid a
// purge elsewhere freed, and a restart, which starts over whatever changed.
// What it keeps goes once its fill ends or the lookup is deleted, and is found
// only under its own user.
// Over 200 lines: the cases of one check (runs, purges, a restart, what it keeps) share their scenes.
import assert from 'node:assert/strict'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import colMod from '../../server/src/services/lookup-column'
import changesMod from '../../server/src/services/lookup-fill-changes'
import waitMod from '../../server/src/services/derived-fill-wait'
import deleteMod from '../../server/src/services/column-delete'
import lifecycleMod from '../../server/src/services/run-lifecycle'
const { derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { readsChangedUnseen, lookupFillsKept } =
  changesMod as typeof import('../../server/src/services/lookup-fill-changes')
const { fillEnded } = waitMod as typeof import('../../server/src/services/derived-fill-wait')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const k = lookupWaitKit('lookup-fill-changes')
const { db, uid, ok, done, place, cells, statusOf, until, lookup, formula, refillFormula, fillF, fillingFrom,
  resumeLookups, rec, rowids, setCells, httpRun, endRun, resumeRun, runNote, oneRowASlice, probe } = k
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

await ok('a paused run on a column it reads that goes on and ends between two looks while it waits for an auto-run '
  + 'batch run: every row again', async () => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  const paused = httpRun(o, 'Name', false, 'paused')
  const { run, slow } = await waitsForABatch(a, o, id, 'Name')
  try {
    resumeRun(paused)
    setCells(o, 'Name', M)
    endRun(paused)
    endRun(run)
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  assert.deepEqual(cells(a, 'Who'), M)
})

await ok('a paused run on a column it reads that goes on while it waits for an auto-run batch run ends that wait at '
  + 'once: it waits for that run from the first row', async () => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  const paused = httpRun(o, 'Name', false, 'paused')
  const { run, slow } = await waitsForABatch(a, o, id, 'Name')
  try {
    resumeRun(paused)
    await until('it waits for the resumed run', () => derivedFillWait(id) === runNote(o, 'Name'), 4_000)
    assert.equal(rec(id)!.fill_cursor, 0, 'it starts over, the batch run still going')
    setCells(o, 'Name', M)
    endRun(paused)
    endRun(run)
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  assert.deepEqual(cells(a, 'Who'), M)
})

await ok('a paused run on a column it reads cancelled while it waits for an auto-run batch run: it goes on where '
  + 'it was', async () => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  const paused = httpRun(o, 'Name', false, 'paused')
  const { run, slow } = await waitsForABatch(a, o, id, 'Name')
  try {
    assert.deepEqual(await cancelRun('http', paused, uid), { ok: true })
    // An edit isn't a change it starts over for: the rows after its first show it.
    setCells(o, 'Name', M)
    endRun(run)
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  assert.deepEqual(cells(a, 'Who'), ['N0', 'M1', 'M2'])
})

// `o` with an older run on Name, the newest run row on another sheet, and a lookup's record looking in `o`
// that took its look; look(): its next look, with rows written.
const READS = ['Email', 'Name']
const scene = () => {
  const o = place().sid, elsewhere = place().sid
  httpRun(o, 'Name', false, 'completed')
  const newest = httpRun(elsewhere, 'Other', false, 'completed')
  const p = probe(o)
  assert.equal(readsChangedUnseen(p, READS), null)
  const look = () => readsChangedUnseen({ ...p, fill_cursor: 1 }, READS)
  return { o, newest, look, finish: () => db.prepare("UPDATE lookup_columns SET fill_status = 'done' WHERE id = ?")
    .run(p.id) }
}
const rowidOf = (run: string) => db.prepare('SELECT rowid FROM http_runs WHERE id = ?').pluck().get(run) as number
const purge = (run: string) => db.prepare('DELETE FROM http_runs WHERE id = ?').run(run)

await ok("a run that took the rowid a purge elsewhere freed is still seen; a purge alone isn't a change", async () => {
  const s = scene()
  const at = rowidOf(s.newest)
  purge(s.newest)
  assert.equal(rowidOf(httpRun(s.o, 'Name', false, 'completed')), at, 'the rowid is taken again')
  assert.deepEqual(s.look(), { column: 'Name' })
  s.finish()
  const alone = scene()
  purge(alone.newest)
  assert.equal(alone.look(), null, 'a purge elsewhere alone')
  alone.finish()
})

// As a restart finds it: rows 1 and 2 written, the cursor past them; nothing in this process saw them written.
const foundAtRestart = (a: string, id: string) => {
  setCells(a, 'Who', ['old0', 'old1'])
  fillingFrom(id, rowids(a)[1], 2)
}

await ok('a restart that finds it with rows written looks every row up again, whatever changed: nothing, or an '
  + 'auto-run batch run', async () => {
  for (const batch of [false, true]) {
    const a = place().sid, o = place().sid
    const id = await lookup(a, o, 'Who', 'value', 'Name')
    if (batch) {
      setCells(o, 'Name', M)
      httpRun(o, 'Name', true, 'completed')
    }
    foundAtRestart(a, id)
    resumeLookups()
    await until('it is done', () => statusOf(a, 'Who') === 'done')
    assert.deepEqual(cells(a, 'Who'), batch ? M : ['N0', 'N1', 'N2'], batch ? 'auto-run batch' : 'nothing')
  }
})

await ok('a fill that ended, or a lookup deleted, loses what it kept, and its sheet stops counting fill ends',
  async () => {
    const o = place().sid, ended = probe(o), deleted = probe(o)
    for (const p of [ended, deleted]) assert.equal(readsChangedUnseen(p, READS), null)
    const kept = () => lookupFillsKept()
    assert.ok([ended.id, deleted.id].every(id => kept().lookups.includes(id)) && kept().sheets.includes(o))
    db.prepare("UPDATE lookup_columns SET fill_status = 'done' WHERE id = ?").run(ended.id)
    db.prepare('DELETE FROM lookup_columns WHERE id = ?').run(deleted.id)
    fillEnded(place().sid, 'Name') // a fill ends somewhere
    assert.ok(![ended.id, deleted.id].some(id => kept().lookups.includes(id)), JSON.stringify(kept()))
    assert.ok(!kept().sheets.includes(o))
    fillEnded(o, 'Name')
    assert.ok(!kept().sheets.includes(o), 'nothing looks there: not counted')
    // A lookup is found only under its own user: asked about under another, it's not filling there.
    const elsewhere = probe(o)
    assert.equal(readsChangedUnseen({ ...elsewhere, user_id: 'another-user' }, READS), null)
    fillEnded(place().sid, 'Name')
    assert.ok(!kept().lookups.includes(elsewhere.id), 'forgotten')
    db.prepare("UPDATE lookup_columns SET fill_status = 'done' WHERE id = ?").run(elsewhere.id)
  })

await ok('a lookup deleted while it waits loses what it kept once its wait sees it gone', async () => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  const { run, slow } = await waitsForABatch(a, o, id, 'Name')
  try {
    assert.ok(lookupFillsKept().lookups.includes(id))
    assert.deepEqual(await deleteSheetColumn(a, uid, 'Who'), { ok: true })
    await until('it is forgotten', () => !lookupFillsKept().lookups.includes(id), 3_000)
  } finally {
    slow.restore()
    endRun(run)
  }
})

done()
