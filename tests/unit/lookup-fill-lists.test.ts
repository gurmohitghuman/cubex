// A lookup returning a list of every column of the other sheet reads each of
// them: its fill waits for a formula column there to finish filling, and it
// counts in the loop check (starting one that would close a loop through it,
// even as a new column, or starting it again where it would, is refused). Stored answers filling a column there
// hold only that column: a lookup reading other columns goes on, one reading
// it waits for it, and goes on when it ends.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import waitMod from '../../server/src/services/derived-fill-wait'
import colMod from '../../server/src/services/lookup-column'
import busyMod from '../../server/src/lib/sheet-busy'
import fieldMod from '../../server/src/lib/field-fill-columns'
const { derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { fillEnded } = waitMod as typeof import('../../server/src/services/derived-fill-wait')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { FIELD_FILLING } = fieldMod as typeof import('../../server/src/lib/field-fill-columns')
const k = lookupWaitKit('lookup-fill-lists')
const { db, uid, ok, done, place, cells, statusOf, until, lookup, sheetName, formula, refillFormula, fillF,
  fillingFrom, resumeLookups, setCells } = k
const rec = (sid: string, column: string) =>
  db.prepare('SELECT id FROM lookup_columns WHERE sheet_id = ? AND column_name = ?').pluck().get(sid, column) as string
console.error = () => {}

const waitsFor = (column: string, o: string) => `Waits for "${column}" in "${sheetName(o)}" to finish filling.`

await ok('a list of every column waits for a formula column there to finish filling, then lists its new values',
  async () => {
    const a = place().sid, o = place().sid
    const fid = await formula(o, '-v1')
    const id = await lookup(a, o, 'All', 'list')
    refillFormula(fid, '-v1', '-v2')
    fillingFrom(id)
    resumeLookups()
    await until('it waits', () => derivedFillWait(id) === waitsFor('F', o))
    await fillF(o, fid)
    await until('it is done', () => statusOf(a, 'All') === 'done')
    assert.deepEqual(cells(a, 'All').map(c => JSON.parse(c ?? '[]')[0]?.F), ['N0-v2', 'N1-v2', 'N2-v2'])
  })

await ok('starting a lookup that a filling list of every column would wait for, in a loop, is refused', async () => {
  const s0 = place().sid, s1 = place().sid
  const all = await lookup(s1, s0, 'All', 'list')
  fillingFrom(all) // its fill hasn't looked yet
  const input = { column: 'Back', sourceColumn: 'Email', otherSheetId: s1, matchColumn: 'Email', returns: 'value',
    returnColumn: 'All' }
  const out = await startLookupColumn(uid, s0, input)
  assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
  const at = (c: string, s: string) => `"${c}" in "${sheetName(s)}"`
  assert.equal(out.message, `${at('Back', s0)} would wait for ${at('All', s1)} to finish filling, and `
    + `${at('All', s1)} would wait for ${at('Back', s0)}: neither could finish. Look up once ${at('All', s1)} is done.`)
  resumeLookups()
  await until('All is done', () => statusOf(s1, 'All') === 'done')
  const now = await startLookupColumn(uid, s0, input)
  assert.ok('ok' in now, JSON.stringify(now))
  await until('Back is done', () => statusOf(s0, 'Back') === 'done')
  // The other way round: looking up again the list of every column, while Back (reading it) fills, is refused.
  fillingFrom(rec(s0, 'Back'))
  const list = await startLookupColumn(uid, s1, { column: 'All', sourceColumn: 'Email', otherSheetId: s0,
    matchColumn: 'Email', returns: 'list' })
  assert.ok('fail' in list && list.fail === 'conflict', JSON.stringify(list))
  assert.match(list.message, /^"All" in "[^"]+" would wait for "Back" in "[^"]+" to finish filling/)
  resumeLookups()
  await until('Back is done again', () => statusOf(s0, 'Back') === 'done')
})

await ok('stored answers filling a column: a lookup reading another column goes on, one reading it waits for it',
  async () => {
    const a = place().sid, o = place().sid
    db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Email', 'Name', 'Found']), o)
    const who = await lookup(a, o, 'Who', 'value', 'Name')
    const got = await lookup(a, o, 'Got', 'value', 'Found')
    // The stored answers' job, holding its sheet as it does while it fills Found.
    const job = uuid()
    db.prepare(`INSERT INTO enrichment_field_jobs (id, user_id, sheet_id, status_column, column_name, json_path)
      VALUES (?, ?, ?, 'Status', 'Found', '$.found')`).run(job, uid, o)
    let release!: () => void
    const held = withSheetBusy(o, FIELD_FILLING, () => new Promise<void>(r => { release = r }))
    try {
      fillingFrom(who)
      fillingFrom(got)
      resumeLookups()
      await until('Who is done', () => statusOf(a, 'Who') === 'done')
      await until('Got waits for Found', () => derivedFillWait(got) === waitsFor('Found', o))
      // The job writes Found and ends, as answer-field-fill.ts finishJob does.
      setCells(o, 'Found', ['F0', 'F1', 'F2'])
      db.prepare("UPDATE enrichment_field_jobs SET status = 'done' WHERE id = ?").run(job)
    } finally { release() }
    await held
    fillEnded(o, 'Found')
    await until('Got is done', () => statusOf(a, 'Got') === 'done')
    assert.deepEqual(cells(a, 'Who'), ['N0', 'N1', 'N2'])
    assert.deepEqual(cells(a, 'Got'), ['F0', 'F1', 'F2'])
  })

done()
