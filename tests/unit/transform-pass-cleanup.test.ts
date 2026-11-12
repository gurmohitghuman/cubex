// Over 200 lines: one fixture and every way a pass's record ends or stays, read top to bottom.
// What ends a transform_column pass's record in transform_passes
// (services/column-transform-passes.ts, migration 056). Each case stops a pass
// on an error after 250 rows (its record kept), then: the pass completes; a
// restart: true runs to the end; its column is deleted for good, or goes to the
// trash (the record with it) and is purged; its sheet or its table goes to the
// trash (the record stays) and is purged; its sheet is deleted for good
// (Settings keeps 0 days); a CSV import replaces the rows without its column
// (at once: transform-pass-unlisted.test.ts). Each leaves no record for the
// sheet. Rows moved under it (sorted, replaced by a CSV import keeping the
// column, duplicates removed) keep the record, marked
// (the record of a column in the trash too): the call is refused, and only
// restart: true ends it. A record whose cursor is of an older row_generation
// reads as marked, and is kept.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import deleteMod from '../../server/src/services/column-delete'
import sortMod from '../../server/src/services/sheet-sort'
import importMod from '../../server/src/services/csv-import'
import parseMod from '../../server/src/lib/csv-import-parse'
import dedupeMod from '../../server/src/services/dedupe-remove'
import trashMod from '../../server/src/services/trash-sheets'
import purgeMod from '../../server/src/services/trash-purge'
import storeMod from '../../server/src/lib/trash/store'
import { transformPageFault } from './transform-page-fault'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { importCsv } = importMod as typeof import('../../server/src/services/csv-import')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')
const { removeDuplicates } = dedupeMod as typeof import('../../server/src/services/dedupe-remove')
const { trashSheet, trashTable } = trashMod as typeof import('../../server/src/services/trash-sheets')
const { getTrashDays, setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const fault = transformPageFault(db)

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 600
const uid = uuid(), tid = uuid(), other = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(other, uid, 'Other')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
let made = 0
// A sheet whose last row repeats the first one's S.
function sheet(tableId = tid): string {
  const id = uuid()
  addSheet.run(id, tableId, uid, `S${made}`, made++, JSON.stringify(['S', 'T']))
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      insert.run(uuid(), id, uid, i, JSON.stringify({ S: `s${i === ROWS - 1 ? 0 : i}`, T: `t${i}` }))
    }
  })()
  return id
}
const call = (sheetId: string) => ({ sheetId, operation: 'template' as const, template: '{{T}}-x', targetColumn: 'T' })
const records = (id: string) => db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(id)
// A pass stopped on an error after 250 rows: its record is there.
async function stopped(id: string): Promise<string> {
  fault.arm(251)
  let out
  try { out = await transformColumn(uid, call(id)) } finally { fault.disarm() }
  assert.ok('stopped' in out, JSON.stringify(out))
  assert.equal(records(id), 1)
  return out.stopped.next_cursor
}
const ok = (out: object) => assert.ok('ok' in out, JSON.stringify(out))
const markedRecords = (id: string) => db.prepare(`SELECT count(*) FROM transform_passes WHERE sheet_id = ?
  AND moved_at IS NOT NULL`).pluck().get(id)
// Kept, marked: the call is refused naming the rows done, until restart: true runs it and ends the record.
async function movedUntilRestart(id: string) {
  assert.equal(records(id), 1, 'kept')
  const out = await transformColumn(uid, call(id)) as { fail?: string; error?: string }
  assert.ok(out.fail === 'invalid' && out.error?.startsWith('Rows of this sheet moved'), JSON.stringify(out))
  assert.equal(records(id), 1)
  ok(await transformColumn(uid, { ...call(id), restart: true }))
  assert.equal(records(id), 0)
}
// Settings keeping deleted things 0 days while `fn` runs.
async function forGood<T>(fn: () => T | Promise<T>): Promise<T> {
  const days = getTrashDays(uid)
  setTrashDays(uid, 0)
  try { return await fn() } finally { setTrashDays(uid, days) }
}
// The Trash page's "Delete for good", waited for.
async function purged(id: number) {
  assert.deepEqual(purgeTrashItems(uid, [id]), [id])
  const left = db.prepare('SELECT count(*) FROM trash_items WHERE id = ?').pluck()
  for (const until = Date.now() + 10_000; left.get(id) !== 0 && Date.now() < until;) {
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(left.get(id), 0, 'purged')
}

async function main() {
  await check('the pass completes', async () => {
    const id = sheet()
    ok(await transformColumn(uid, { ...call(id), cursor: await stopped(id) }))
    assert.equal(records(id), 0)
  })
  await check('restart: true runs to the end', async () => {
    const id = sheet()
    await stopped(id)
    ok(await transformColumn(uid, { ...call(id), restart: true }))
    assert.equal(records(id), 0)
  })
  await check('its column is deleted for good', async () => {
    const id = sheet()
    await stopped(id)
    const out = await forGood(() => deleteSheetColumn(id, uid, 'T'))
    assert.ok('ok' in out && out.trashId === null, JSON.stringify(out))
    assert.equal(records(id), 0)
  })
  await check('its column goes to the trash with it and is purged', async () => {
    const id = sheet()
    await stopped(id)
    const out = await deleteSheetColumn(id, uid, 'T')
    assert.ok('ok' in out && out.trashId !== null, JSON.stringify(out))
    assert.equal(records(id), 1, 'in the trash with its column')
    await purged(out.trashId!)
    assert.equal(records(id), 0)
  })
  await check('its sheet goes to the trash, keeping it, and is purged', async () => {
    const id = sheet()
    await stopped(id)
    const out = trashSheet(uid, tid, id)
    assert.ok('ok' in out && out.ok.trashId !== null, JSON.stringify(out))
    assert.equal(records(id), 1, 'kept in the trash')
    await purged(out.ok.trashId!)
    assert.equal(records(id), 0)
  })
  await check('its table goes to the trash, keeping it, and is purged', async () => {
    const id = sheet(other)
    await stopped(id)
    const out = trashTable(uid, other)
    assert.ok('ok' in out && out.ok.trashId !== null, JSON.stringify(out))
    assert.equal(records(id), 1, 'kept in the trash')
    await purged(out.ok.trashId!)
    assert.equal(records(id), 0)
  })
  await check('its sheet is deleted for good', async () => {
    const id = sheet()
    await stopped(id)
    await forGood(async () => {
      const out = trashSheet(uid, tid, id)
      assert.ok('ok' in out && out.ok.trashId === null, JSON.stringify(out))
      const left = db.prepare('SELECT count(*) FROM sheets WHERE id = ?').pluck()
      for (const until = Date.now() + 10_000; left.get(id) !== 0 && Date.now() < until;) {
        await new Promise(r => setTimeout(r, 20))
      }
      assert.equal(left.get(id), 0, 'the sheet was deleted for good')
      assert.equal(records(id), 0)
    })
  })
  await check('its rows are sorted, its column in the trash or not: kept, marked, until restart', async () => {
    const id = sheet()
    await stopped(id)
    ok(await physicalSortSheet(id, uid, 'T', 'desc'))
    assert.equal(markedRecords(id), 1)
    await movedUntilRestart(id)
    await stopped(id)
    ok(await deleteSheetColumn(id, uid, 'T'))
    assert.equal(records(id), 1, 'in the trash with its column')
    ok(await physicalSortSheet(id, uid, 'S', 'desc'))
    assert.equal(markedRecords(id), 1, 'marked in the trash')
  })
  await check('its rows are replaced by a CSV import keeping its column: kept, marked, until restart', async () => {
    const id = sheet()
    await stopped(id)
    ok(await importCsv(id, uid, await scanCsvText('S,T\na,b\n'), true))
    await movedUntilRestart(id)
  })
  await check('its rows are replaced by a CSV import without its column: the record goes with it', async () => {
    const id = sheet()
    await stopped(id)
    ok(await importCsv(id, uid, await scanCsvText('S\na\n'), true))
    assert.equal(records(id), 0, 'gone with its column, in the replace')
    assert.deepEqual(await transformColumn(uid, { sheetId: id, operation: 'upper', sourceColumn: 'S',
      targetColumn: 'T' }), { ok: { updated: 1, created_column: 'T' } })
    assert.equal(records(id), 0)
  })
  await check('its duplicates are removed: kept, marked, until restart', async () => {
    const id = sheet()
    await stopped(id)
    const out = await removeDuplicates(uid, id, { columns: ['S'] })
    assert.ok('ok' in out && out.ok.removed === 1, JSON.stringify(out))
    await movedUntilRestart(id)
  })
  await check('a record whose cursor is of an older row_generation reads as marked and is kept', async () => {
    // Made here by a sort with the trigger that marks such a record dropped (last: it stays dropped).
    db.exec('DROP TRIGGER IF EXISTS transform_passes_row_generation')
    const id = sheet()
    await stopped(id)
    ok(await physicalSortSheet(id, uid, 'T', 'desc'))
    assert.equal(markedRecords(id), 0, 'not marked by the sort')
    await movedUntilRestart(id)
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pass-cleanup assertions passed.')
    process.exit(0)
  })
