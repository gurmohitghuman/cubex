// Rows moved under an unfinished transform_column pass mark it, never drop it (services/column-transform-pass-
// moves.ts, migration 056). Each case stops `{{T}}-x` into T after 250 of 650 rows (a page fails), then: a sort,
// and every call into T is refused, with its cursor or without, whatever its arguments, writing nothing and
// naming the 250 rows; restart: true then runs from the first row as a new pass, unmarked, that goes on with its
// own cursor (the 250 rows get the operation twice, as the refusal said). Rows restored from the trash to the end
// of the sheet, all after the cursor, cross nothing: the pass goes on and every row gets the operation once. T in
// the trash during a sort comes back with its pass marked. A copy of the sheet made after a sort gets its pass
// marked too.
import assert from 'node:assert/strict'
import transformMod from '../../server/src/services/column-transform'
import sortMod from '../../server/src/services/sheet-sort'
import writeMod from '../../server/src/services/rows-write'
import copyMod from '../../server/src/services/sheet-copy'
import { columnTrashKit } from './column-trash-kit'
import { transformPageFault } from './transform-page-fault'
import { moved, unfinished } from './transform-pass-words'
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { appendRows, deleteRowsByIds } = writeMod as typeof import('../../server/src/services/rows-write')
const { copySheetValues } = copyMod as typeof import('../../server/src/services/sheet-copy')
type Params = import('../../server/src/services/column-transform').TransformParams

const { db, uid, ok, done, sheet, del, restoreOne } = columnTrashKit('transform-pass-moved')
const fault = transformPageFault(db)
const ROWS = 650
const fresh = () => sheet(['S', 'T'], Array.from({ length: ROWS }, (_, i) => ({ S: `s${i}`, T: `t${i}` })))
// Reads its own target: a row the operation reached twice ends "-x-x".
const call = (sheetId: string): Params => ({ sheetId, operation: 'template', template: '{{T}}-x', targetColumn: 'T' })
const cells = (id: string) => db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(id)
const ending = (id: string, glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.T') GLOB ?`).pluck().get(id, glob) as number
type Rec = { pass_id: string; moved_at: string | null; trash_id: number | null }
const passes = (id: string) => db.prepare('SELECT pass_id, moved_at, trash_id FROM transform_passes WHERE sheet_id = ?')
  .all(id) as Rec[]
// Stopped on its second page: the cursor after 250 rows.
async function stopped(p: Params): Promise<string> {
  fault.arm(251)
  try {
    const out = await transformColumn(uid, p)
    assert.ok('stopped' in out && out.stopped.rows_done === 250, JSON.stringify(out))
    return out.stopped.next_cursor
  } finally { fault.disarm() }
}
async function refused(p: Params, answer: object) {
  const before = cells(p.sheetId)
  assert.deepEqual(await transformColumn(uid, p), answer)
  assert.equal(cells(p.sheetId), before, 'nothing written')
}
async function sorted(id: string) {
  const out = await physicalSortSheet(id, uid, 'S', 'desc')
  assert.ok('ok' in out, JSON.stringify(out))
}

async function main() {
  // A table keeps at least one sheet: this one stays.
  sheet(['X'], [{ X: 'x' }])
  await ok('after a sort, every call into T is refused naming the 250 rows done, writing nothing', async () => {
    const sid = fresh()
    const cursor = await stopped(call(sid))
    await sorted(sid)
    const [rec] = passes(sid)
    assert.ok(rec && rec.moved_at !== null, 'marked, not dropped')
    await refused(call(sid), moved('T', 250))
    await refused({ ...call(sid), cursor }, moved('T', 250))
    await refused({ sheetId: sid, operation: 'upper', sourceColumn: 'S', targetColumn: 'T' }, moved('T', 250))
    assert.equal(ending(sid, '*-x-x'), 0)
  })

  await ok('restart: true after a sort runs from the first row as a new pass, which goes on with its cursor',
    async () => {
      const sid = fresh()
      const old = await stopped(call(sid))
      const [before] = passes(sid)
      await sorted(sid)
      await refused(call(sid), moved('T', 250))
      const cursor = await stopped({ ...call(sid), restart: true })
      const [now] = passes(sid)
      assert.ok(now && now.pass_id !== before.pass_id && now.moved_at === null, JSON.stringify(now))
      await refused({ ...call(sid), cursor: old }, unfinished('T', 250, cursor))
      assert.deepEqual(await transformColumn(uid, { ...call(sid), cursor }),
        { ok: { updated: ROWS - 250, created_column: null } })
      assert.equal(ending(sid, 't*-x'), ROWS)
      assert.equal(ending(sid, '*-x-x'), 250, 'the rows the first pass did get it again, as the refusal said')
      assert.deepEqual(passes(sid), [])
    })

  await ok('rows restored from the trash to the end, all after the cursor, cross nothing: the pass goes on, every '
    + 'row gets the operation once', async () => {
    const sid = fresh()
    const cursor = await stopped(call(sid))
    const ids = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index >= 600').pluck().all(sid) as string[]
    const gone = deleteRowsByIds(sid, uid, ids)
    assert.ok('ok' in gone && gone.ok.deleted === 50 && gone.ok.trashId !== null, JSON.stringify(gone))
    // Ten new rows take the old places of the first ten: the batch comes back at the end.
    assert.ok('ok' in appendRows(sid, uid, Array.from({ length: 10 }, (_, i) => ({ S: `n${i}`, T: `n${i}` }))))
    const r = await restoreOne(gone.ok.trashId!)
    assert.ok(r.restored, JSON.stringify(r))
    const places = db.prepare(`SELECT min(row_index) FROM rows WHERE sheet_id = ? AND id IN
      (SELECT value FROM json_each(?))`).pluck().get(sid, JSON.stringify(ids)) as number
    assert.ok(places >= 610, `restored at ${places}: not moved`)
    assert.equal(passes(sid)[0]?.moved_at, null, 'not marked')
    await refused(call(sid), unfinished('T', 250, cursor))
    assert.deepEqual(await transformColumn(uid, { ...call(sid), cursor }),
      { ok: { updated: ROWS + 10 - 250, created_column: null } })
    assert.equal(ending(sid, '*-x'), ROWS + 10)
    assert.equal(ending(sid, '*-x-x'), 0)
  })

  await ok('T in the trash during a sort comes back with its pass marked: refused with its cursor or without',
    async () => {
      const sid = fresh()
      const cursor = await stopped(call(sid))
      const item = (await del(sid, 'T'))!
      assert.ok(item !== null)
      await sorted(sid)
      assert.deepEqual(passes(sid).map(p => [p.trash_id, p.moved_at !== null]), [[item, true]])
      const back = await restoreOne(item)
      assert.equal((back.restored as { name?: string } | undefined)?.name, 'T', JSON.stringify(back))
      await refused(call(sid), moved('T', 250))
      await refused({ ...call(sid), cursor }, moved('T', 250))
    })

  await ok('a copy of the sheet made after a sort gets its pass marked too', async () => {
    const sid = fresh()
    await stopped(call(sid))
    await sorted(sid)
    const out = await copySheetValues(uid, sid, { columns: ['S', 'T'] })
    assert.ok('ok' in out && out.ok.rowsCopied === ROWS, JSON.stringify(out).slice(0, 300))
    await refused(call(out.ok.sheet.id), moved('T', 250))
  })
  done()
}

main().catch(e => { console.log('FAIL threw', e); process.exit(1) })
