// An unfinished transform_column pass through the trash (services/column-transform-pass-moves.ts). Each case
// stops `{{T}}-x` into T after 250 of 650 rows (a page fails), then: its sheet goes to the trash and comes back
// (T renamed T2 first, too); its column goes to the trash and comes back under its own name, or under a new one
// while a column of its name was added meanwhile, which has no pass and runs from the top. Each time, the call
// without cursor is refused and writes nothing, and going on with the cursor ends every row exactly once. Purged
// for good (the sheet, the column), no record is left. Rows deleted under the cursor and restored from the trash
// to the end of the sheet mark the pass: its cursor is refused, and no row gets the operation twice.
import assert from 'node:assert/strict'
import transformMod from '../../server/src/services/column-transform'
import renameMod from '../../server/src/services/column-rename'
import addMod from '../../server/src/services/column-add'
import trashMod from '../../server/src/services/trash-sheets'
import purgeMod from '../../server/src/services/trash-purge'
import writeMod from '../../server/src/services/rows-write'
import { columnTrashKit } from './column-trash-kit'
import { transformPageFault } from './transform-page-fault'
import { moved, unfinished } from './transform-pass-words'
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
const { trashSheet } = trashMod as typeof import('../../server/src/services/trash-sheets')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')
const { appendRows, deleteRowsByIds } = writeMod as typeof import('../../server/src/services/rows-write')
type Params = import('../../server/src/services/column-transform').TransformParams

const { db, uid, tid, ok, done, sheet, del, restoreOne } = columnTrashKit('transform-pass-trash')
const fault = transformPageFault(db)
const ROWS = 650
const fresh = () => sheet(['S', 'T'], Array.from({ length: ROWS }, (_, i) => ({ S: `s${i}`, T: `t${i}` })))
const call = (sheetId: string, t = 'T'): Params => ({ sheetId, operation: 'template', template: `{{${t}}}-x`,
  targetColumn: t })
const cells = (id: string) => db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(id)
const ending = (id: string, t: string, glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, ?) GLOB ?`).pluck().get(id, `$."${t}"`, glob) as number
const records = (id: string) => db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(id)
// Stopped on its second page: the cursor after 250 rows.
async function stopped(p: Params): Promise<string> {
  fault.arm(251)
  try {
    const out = await transformColumn(uid, p)
    assert.ok('stopped' in out && out.stopped.rows_done === 250, JSON.stringify(out))
    return out.stopped.next_cursor
  } finally { fault.disarm() }
}
// Refused naming the cursor, writing nothing; then the cursor ends every row of `t` once.
async function goesOn(p: Params, t: string, cursor: string) {
  const before = cells(p.sheetId)
  assert.deepEqual(await transformColumn(uid, p), unfinished(t, 250, cursor))
  assert.equal(cells(p.sheetId), before, 'nothing written')
  assert.deepEqual(await transformColumn(uid, { ...p, cursor }), { ok: { updated: ROWS - 250, created_column: null } })
  assert.equal(ending(p.sheetId, t, 't*-x'), ROWS)
  assert.equal(ending(p.sheetId, t, '*-x-x'), 0)
  assert.equal(records(p.sheetId), 0)
}
const restored = async (id: number) => {
  const r = await restoreOne(id)
  assert.ok(r.restored, JSON.stringify(r))
  return r.restored as { name?: string }
}
async function purged(id: number) {
  assert.deepEqual(purgeTrashItems(uid, [id]), [id])
  const left = db.prepare('SELECT count(*) FROM trash_items WHERE id = ?').pluck()
  for (const until = Date.now() + 10_000; left.get(id) !== 0 && Date.now() < until;) {
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(left.get(id), 0, 'purged')
}
const trashed = (sid: string) => {
  const out = trashSheet(uid, tid, sid)
  assert.ok('ok' in out && out.ok.trashId !== null, JSON.stringify(out))
  return out.ok.trashId!
}

async function main() {
  // A table keeps at least one sheet: this one stays.
  sheet(['X'], [{ X: 'x' }])
  await ok('its sheet goes to the trash and comes back: still refused without cursor, the cursor ends it', async () => {
    const sid = fresh()
    const cursor = await stopped(call(sid))
    await restored(trashed(sid))
    await goesOn(call(sid), 'T', cursor)
  })

  await ok('T renamed T2, then its sheet to the trash and back: the pass is T2\'s', async () => {
    const sid = fresh()
    const cursor = await stopped(call(sid))
    assert.deepEqual(await renameSheetColumn(sid, uid, 'T', 'T2'), { ok: true, newName: 'T2' })
    await restored(trashed(sid))
    await goesOn(call(sid, 'T2'), 'T2', cursor)
  })

  await ok('its column goes to the trash and comes back under its own name', async () => {
    const sid = fresh()
    const cursor = await stopped(call(sid))
    const item = (await del(sid, 'T'))!
    assert.ok(item !== null)
    assert.equal(records(sid), 1, 'in the trash with its column')
    assert.equal((await restored(item)).name, 'T')
    await goesOn(call(sid), 'T', cursor)
  })

  await ok('a column added under its name meanwhile has no pass and runs from the top; the old one comes back '
    + 'under a new name with its pass', async () => {
    const sid = fresh()
    const cursor = await stopped(call(sid))
    const item = (await del(sid, 'T'))!
    assert.ok('ok' in addSheetColumn(sid, uid, 'T'))
    assert.deepEqual(await transformColumn(uid, call(sid)), { ok: { updated: ROWS, created_column: null } })
    assert.equal(ending(sid, 'T', '-x'), ROWS, 'every row of the new T, from the top')
    assert.equal((await restored(item)).name, 'T (restored)')
    await goesOn(call(sid, 'T (restored)'), 'T (restored)', cursor)
  })

  await ok('purged for good: its column\'s trash item, or its sheet, leaves no record', async () => {
    const a = fresh()
    await stopped(call(a))
    await purged((await del(a, 'T'))!)
    assert.equal(records(a), 0)
    const b = fresh()
    await stopped(call(b))
    await purged(trashed(b))
    assert.equal(db.prepare('SELECT count(*) FROM sheets WHERE id = ?').pluck().get(b), 0)
    assert.equal(records(b), 0)
  })

  await ok('rows deleted under the cursor and restored to the end of the sheet: the call with its cursor is '
    + 'refused naming the 250 rows, no row gets the operation twice', async () => {
    const sid = fresh()
    const cursor = await stopped(call(sid))
    const ids = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index >= 200 ORDER BY row_index')
      .pluck().all(sid) as string[]
    const gone = deleteRowsByIds(sid, uid, ids)
    assert.ok('ok' in gone && gone.ok.deleted === 450 && gone.ok.trashId !== null, JSON.stringify(gone))
    assert.ok('ok' in appendRows(sid, uid, Array.from({ length: 10 }, (_, i) => ({ S: `n${i}`, T: `n${i}` }))))
    await restored(gone.ok.trashId!)
    const before = cells(sid)
    assert.deepEqual(await transformColumn(uid, { ...call(sid), cursor }), moved('T', 250))
    assert.equal(cells(sid), before, 'nothing written')
    assert.equal(records(sid), 1, 'kept, marked')
    assert.equal(ending(sid, 'T', '*-x-x'), 0)
  })
  done()
}

main().catch(e => { console.log('FAIL threw', e); process.exit(1) })
