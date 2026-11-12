// A column that leaves column_order without a delete is gone for good, and so is its unfinished transform_column
// pass (forgetUnlistedTransformPasses, services/column-transform-pass-moves.ts). Each case stops `{{T}}-x` into T
// after 250 of 600 rows (a page fails), then replaces the rows with a CSV file that has only S: imported, or cut
// short and undone (the undo lists the file's columns too). A column T added after that has no pass and runs; with
// a pass into S stopped too, renaming S to T works, S's pass follows it under T (marked: its rows moved), and no
// row keeps a key the sheet doesn't list. A column T in the trash meanwhile keeps its pass with its trash item and
// gets it back on restore, marked by the replace. A transfer into a sheet still as created lists only what it
// brings, leaving out the starter "Column 1": a pass into "Column 1" (stopped at 250 of 600 blank rows, rows 3 to
// 599 then deleted, so the sheet reads as created again) ends with it, so a new "Column 1" runs, and X renamed
// "Column 1" takes X's pass along.
import assert from 'node:assert/strict'
import transformMod from '../../server/src/services/column-transform'
import renameMod from '../../server/src/services/column-rename'
import addMod from '../../server/src/services/column-add'
import importMod from '../../server/src/services/csv-import'
import parseMod from '../../server/src/lib/csv-import-parse'
import transferMod from '../../server/src/services/rows-transfer'
import seedMod from '../../server/src/services/transfer-seed'
import trashMod from '../../server/src/services/trash-rows'
import { columnTrashKit } from './column-trash-kit'
import { transformPageFault } from './transform-page-fault'
import { moved } from './transform-pass-words'
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
const { importCsv } = importMod as typeof import('../../server/src/services/csv-import')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')
const { transferRows } = transferMod as typeof import('../../server/src/services/rows-transfer')
const { isPristineSeedSheet } = seedMod as typeof import('../../server/src/services/transfer-seed')
const { deleteRowsToTrash } = trashMod as typeof import('../../server/src/services/trash-rows')
type Params = import('../../server/src/services/column-transform').TransformParams

const { db, uid, ok, done, sheet, order, del, restoreOne } = columnTrashKit('transform-pass-unlisted')
const fault = transformPageFault(db)
const ROWS = 600
const fresh = () => sheet(['S', 'T'], Array.from({ length: ROWS }, (_, i) => ({ S: `s${i}`, T: `t${i}` })))
const call = (sheetId: string, t: string): Params => ({ sheetId, operation: 'template', template: `{{${t}}}-x`,
  targetColumn: t })
const passes = (id: string) => db.prepare(`SELECT target_column, started_as, rows_done, trash_id IS NOT NULL AS held,
  moved_at IS NOT NULL AS marked FROM transform_passes WHERE sheet_id = ? ORDER BY target_column`).all(id)
// Keys rows hold that the sheet doesn't list.
const unlisted = (id: string) => db.prepare(`SELECT DISTINCT je.key FROM rows r, json_each(r.data) je
  WHERE r.sheet_id = ? AND je.key NOT IN (SELECT value FROM json_each((SELECT column_order FROM sheets
  WHERE id = r.sheet_id)))`).pluck().all(id)
async function stopped(sheetId: string, t: string, params = call(sheetId, t)): Promise<string> {
  fault.arm(251)
  try {
    const out = await transformColumn(uid, params)
    assert.ok('stopped' in out && out.stopped.rows_done === 250, JSON.stringify(out))
    return out.stopped.next_cursor
  } finally { fault.disarm() }
}
const FILE = 'S\na\nb\n'
async function replaced(id: string) {
  const out = await importCsv(id, uid, await scanCsvText(FILE), true)
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual(order(id), ['S'])
}
// The same replace, its upload cut short after its first row: undone, the sheet left with the file's columns.
async function undone(id: string) {
  const csv = await scanCsvText(FILE)
  const cut = { ...csv, rows: async function* () {
    for await (const row of csv.rows()) { yield row; throw new Error('upload cut short') }
  } }
  await assert.rejects(importCsv(id, uid, cut, true), /upload cut short/)
  assert.deepEqual(order(id), ['S'])
}
const upper = (sheetId: string): Params => ({ sheetId, operation: 'upper', sourceColumn: 'S', targetColumn: 'T' })
const SEED = 'Column 1'
// A sheet as created (only "Column 1", 3 blank rows) holding a pass into "Column 1" that stopped at 250 rows.
async function createdWithPass(): Promise<string> {
  const id = sheet([SEED], Array.from({ length: ROWS }, () => ({ [SEED]: '' })))
  await stopped(id, SEED, { sheetId: id, operation: 'upper', sourceColumn: SEED, targetColumn: SEED })
  deleteRowsToTrash(id, uid, 'api', { indexes: Array.from({ length: ROWS - 3 }, (_, i) => i + 3) })
  assert.ok(isPristineSeedSheet(id, uid))
  assert.deepEqual(passes(id), [{ target_column: SEED, started_as: SEED, rows_done: 250, held: 0, marked: 0 }])
  return id
}
let transfers = 0
function transferX(source: string, to: string) {
  const out = transferRows(uid, { sourceSheetId: source, destinationSheetId: to, operation: 'copy',
    selection: { all: true }, columnMode: 'create_missing', columnModeOmitted: false, columnMapping: {},
    idempotencyKey: `unlisted-${++transfers}` })
  assert.ok('ok' in out && out.ok.copied === ROWS, JSON.stringify(out))
  assert.deepEqual(order(to), ['X'])
}

async function main() {
  for (const [how, drop] of [['a CSV replace', replaced], ['an import undone', undone]] as const) {
    await ok(`${how} without T: a new column T has no pass and runs`, async () => {
      const id = fresh()
      await stopped(id, 'T')
      await drop(id)
      assert.ok('ok' in addSheetColumn(id, uid, 'T'))
      const rows = db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(id)
      assert.deepEqual(await transformColumn(uid, upper(id)), { ok: { updated: rows, created_column: null } })
      assert.deepEqual(passes(id), [])
    })
    await ok(`${how} keeping S, without T: S renamed T takes S's pass along, no key left unlisted`, async () => {
      const id = fresh()
      await stopped(id, 'T')
      await stopped(id, 'S')
      await drop(id)
      assert.deepEqual(await renameSheetColumn(id, uid, 'S', 'T'), { ok: true, newName: 'T' })
      assert.deepEqual(order(id), ['T'])
      assert.deepEqual(passes(id), [{ target_column: 'T', started_as: 'S', rows_done: 250, held: 0, marked: 1 }])
      assert.deepEqual(unlisted(id), [])
      assert.deepEqual(await transformColumn(uid, call(id, 'T')), moved('T', 250))
    })
  }

  await ok('T in the trash during a replace: its pass stays with its trash item, and comes back on restore, '
    + 'marked', async () => {
    const id = fresh()
    const cursor = await stopped(id, 'T')
    const item = await del(id, 'T')
    assert.ok(item !== null)
    await replaced(id)
    assert.deepEqual(passes(id), [{ target_column: 'T', started_as: 'T', rows_done: 250, held: 1, marked: 1 }])
    const back = await restoreOne(item)
    assert.equal((back.restored as { name?: string } | undefined)?.name, 'T', JSON.stringify(back))
    assert.deepEqual(passes(id), [{ target_column: 'T', started_as: 'T', rows_done: 250, held: 0, marked: 1 }])
    assert.deepEqual(await transformColumn(uid, { ...call(id, 'T'), cursor }), moved('T', 250))
  })
  const source = sheet(['X'], Array.from({ length: ROWS }, (_, i) => ({ X: `x${i}` })))
  await ok('a transfer into a sheet as created leaves out "Column 1": its pass ends, a new "Column 1" runs',
    async () => {
      const id = await createdWithPass()
      transferX(source, id)
      assert.deepEqual(passes(id), [])
      assert.ok('ok' in addSheetColumn(id, uid, SEED))
      assert.deepEqual(await transformColumn(uid, { sheetId: id, operation: 'template', template: '{{X}}-y',
        targetColumn: SEED }), { ok: { updated: ROWS, created_column: null } })
      assert.deepEqual(passes(id), [])
    })
  await ok(`a transfer into a sheet as created: X renamed "Column 1" takes X's pass along, no key left unlisted`,
    async () => {
      const id = await createdWithPass()
      transferX(source, id)
      await stopped(id, 'X')
      assert.deepEqual(await renameSheetColumn(id, uid, 'X', SEED), { ok: true, newName: SEED })
      assert.deepEqual(order(id), [SEED])
      assert.deepEqual(passes(id), [{ target_column: SEED, started_as: 'X', rows_done: 250, held: 0, marked: 0 }])
      assert.deepEqual(unlisted(id), [])
    })
  done()
}

main().catch(e => { console.log('FAIL threw', e); process.exit(1) })
