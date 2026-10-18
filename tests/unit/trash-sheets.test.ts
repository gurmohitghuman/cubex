// Deleted sheets and tables kept whole in the trash (services/trash-sheets.ts,
// trash-restore-sheet.ts, trash-purge.ts). Pins: a deleted sheet is hidden from
// every lookup by id and every list, its runs and setups stop, its webhook
// stops taking deliveries, its name is free, lookups into it stop with a
// message; the last sheet of a table can't go; restoring brings it back as it
// was (renamed when its name was taken), lookups start again; a sheet whose
// table is in the trash waits for the table; a table goes with its sheets and
// comes back with them (not one deleted on its own before); the purge deletes
// a sheet's rows, results and batches, then the sheet, and a table's sheets.
import assert from 'node:assert/strict'
import sheetsMod from '../../server/src/services/trash-sheets'
import restoreMod from '../../server/src/services/trash-restore-sheet'
import rowsRestoreMod from '../../server/src/services/trash-restore'
import purgeMod from '../../server/src/services/trash-purge'
import sqlMod from '../../server/src/lib/sql-helpers'
import crudMod from '../../server/src/lib/sheet-crud-helpers'
import workspaceMod from '../../server/src/services/workspace-read'
import readMod from '../../server/src/services/trash-read'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
const { trashSheet, trashTable } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { restoreSheetItem } = restoreMod as typeof import('../../server/src/services/trash-restore-sheet')
const { restoreRows } = rowsRestoreMod as typeof import('../../server/src/services/trash-restore')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')
const { verifySheetOwnership } = sqlMod as typeof import('../../server/src/lib/sql-helpers')
const { listSheets, sheetNameTaken } = crudMod as typeof import('../../server/src/lib/sheet-crud-helpers')
const { listTablesWithSheets } = workspaceMod as typeof import('../../server/src/services/workspace-read')
const { listTrash } = readMod as typeof import('../../server/src/services/trash-read')
const { db, uid, tid, ok, done, fixture, rowsOf, item, del } = trashKit('trash-sheets')

const nameOf = (sid: string) => db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(sid) as string
const exists = (sql: string, ...p: unknown[]) => !!db.prepare(sql).get(...p)
const waitGone = async (id: number) => {
  for (let i = 0; i < 300 && item(id); i++) await new Promise(r => setTimeout(r, 10))
}

await ok('a deleted sheet is hidden, inert and frees its name; the last sheet stays', async () => {
  const a = fixture(4, ['Email', 'Name', 'Status']), b = fixture(4)
  const run = uuid(), setupRun = uuid(), source = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Status')`).run(run, a, uid)
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Status', '⏳ Processing...') WHERE sheet_id = ?`).run(a)
  db.prepare(`INSERT INTO setup_runs (id,user_id,sheet_id,setup_name,plan,steps) VALUES (?,?,?,'S','{}','[]')`)
    .run(setupRun, uid, a)
  db.prepare(`INSERT INTO webhook_sources (id,user_id,sheet_id,name,token_hash,raw_column_name)
    VALUES (?,?,?,'W',?,'Raw')`).run(source, uid, a, `h-${source}`)
  const lookup = uuid()
  db.prepare(`INSERT INTO lookup_columns (id,user_id,sheet_id,column_name,source_column,other_sheet_id,
    match_column,match_mode,returns) VALUES (?,?,?,'L','Email',?,'Email','equals','exists')`).run(lookup, uid, b, a)
  const out = trashSheet(uid, tid, a)
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(verifySheetOwnership(a, uid), null)
  assert.ok(!(listSheets(tid, uid) as Array<{ id: string }>).some(s => s.id === a))
  assert.ok(!listTablesWithSheets(uid)[0].sheets.some(s => s.id === a))
  assert.equal(sheetNameTaken(tid, uid, nameOf(a)), false, 'its name is free')
  assert.equal(rowsOf(a).length, 4, 'its rows stay where they are')
  assert.equal(db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(run), 'cancelled')
  for (let i = 0; i < 100 && db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(run); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(rowsOf(a).every(r => !JSON.parse(r.data).Status), "its run's ⏳ cells clear, as on a cancel")
  assert.equal(db.prepare('SELECT status FROM setup_runs WHERE id = ?').pluck().get(setupRun), 'cancelled')
  assert.match(db.prepare('SELECT broken FROM lookup_columns WHERE id = ?').pluck().get(lookup) as string,
    /it looks in is in the trash/)
  assert.ok(!exists(`SELECT 1 FROM webhook_sources ws WHERE token_hash = ? AND EXISTS
    (SELECT 1 FROM sheets s WHERE s.id = ws.sheet_id AND s.trash_id IS NULL)`, `h-${source}`), 'webhook is 404')
  const entry = listTrash(uid, { kind: 'sheet' }).items.find(i => i.id === out.ok.trashId)!
  assert.equal(entry.rows, 4)
  assert.equal(entry.by, 'Cubex')
  // Every other sheet of the table goes too, but never the last one.
  const others = (listSheets(tid, uid) as Array<{ id: string }>).map(s => s.id)
  for (const id of others.slice(1)) assert.ok('ok' in trashSheet(uid, tid, id))
  const last = trashSheet(uid, tid, others[0])
  assert.ok('fail' in last && last.fail === 'bad_request')
  for (const t of listTrash(uid, { kind: 'sheet' }).items.filter(i => i.id !== out.ok.trashId)) {
    assert.ok('ok' in restoreSheetItem(uid, t.id))
  }
})

await ok('restoring a sheet: back as it was, the last tab, renamed if its name was taken; lookups start again', () => {
  const a = fixture(3), b = fixture(2)
  const name = nameOf(a)
  const lookup = uuid()
  db.prepare(`INSERT INTO lookup_columns (id,user_id,sheet_id,column_name,source_column,other_sheet_id,
    match_column,match_mode,returns) VALUES (?,?,?,'L','Email',?,'Email','equals','exists')`).run(lookup, uid, b, a)
  const out = trashSheet(uid, tid, a)
  assert.ok('ok' in out)
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position) VALUES (?,?,?,?,9)').run(uuid(), tid, uid, name)
  const back = restoreSheetItem(uid, out.ok.trashId)
  assert.ok('ok' in back, JSON.stringify(back))
  assert.equal(back.ok.name, `${name} (restored)`)
  assert.equal(back.ok.renamed, true)
  assert.ok(verifySheetOwnership(a, uid))
  assert.equal(rowsOf(a).length, 3)
  const tabs = listSheets(tid, uid) as Array<{ id: string }>
  assert.equal(tabs.at(-1)!.id, a, 'the last tab')
  assert.equal(db.prepare('SELECT broken FROM lookup_columns WHERE id = ?').pluck().get(lookup), null)
  assert.equal(item(out.ok.trashId), undefined)
  const lines = db.prepare('SELECT action FROM sheet_changes WHERE sheet_id = ? ORDER BY id').pluck().all(a)
  assert.deepEqual(lines, ['sheet_deleted', 'sheet_restored'])
})

await ok('rows of a deleted sheet wait for the sheet; a table goes and comes back with its sheets', async () => {
  const t2 = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(t2, uid, 'Leads')
  const s1 = fixture(3, ['Email', 'Name'], t2), s2 = fixture(3, ['Email', 'Name'], t2), s3 = fixture(1, ['A'], t2)
  const batch = del(s1, [0]).trashId!
  const alone = trashSheet(uid, t2, s3)
  assert.ok('ok' in alone)
  const gone = trashTable(uid, t2)
  assert.ok('ok' in gone)
  assert.equal(verifySheetOwnership(s1, uid), null)
  assert.ok(!listTablesWithSheets(uid).some(t => t.id === t2))
  const blocked = await restoreRows(uid, batch)
  assert.ok('fail' in blocked && /Restore the sheet first/.test(blocked.message))
  const entries = listTrash(uid).items
  assert.match(entries.find(i => i.id === batch)!.blocked!, /table "Leads" is in the trash/)
  assert.match(entries.find(i => i.id === alone.ok.trashId)!.blocked!, /table "Leads" is in the trash/)
  const sheetFirst = restoreSheetItem(uid, alone.ok.trashId)
  assert.ok('fail' in sheetFirst && /Restore the table first/.test(sheetFirst.message))
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(uuid(), uid, 'Leads')
  const back = restoreSheetItem(uid, gone.ok.trashId)
  assert.ok('ok' in back && back.ok.name === 'Leads (restored)')
  assert.ok(verifySheetOwnership(s1, uid) && verifySheetOwnership(s2, uid))
  assert.equal(verifySheetOwnership(s3, uid), null, 'one deleted on its own before stays in the trash')
  const rows = await restoreRows(uid, batch)
  assert.ok('ok' in rows)
})

await ok('the purge deletes a sheet for good: its rows, results and batches, then the sheet', async () => {
  const a = fixture(30)
  const batch = del(a, [0, 2]).trashId!
  const out = trashSheet(uid, tid, a)
  assert.ok('ok' in out)
  purgeTrashItems(uid, [out.ok.trashId])
  await waitGone(out.ok.trashId)
  assert.ok(!exists('SELECT 1 FROM sheets WHERE id = ?', a))
  assert.equal(rowsOf(a).length, 0)
  assert.ok(!exists('SELECT 1 FROM ai_runs WHERE sheet_id = ?', a))
  assert.equal(item(batch), undefined)
  assert.ok(!exists('SELECT 1 FROM trash_rows WHERE item_id = ?', batch))
})

await ok('the purge deletes a table with its sheets, the one deleted on its own too', async () => {
  const t3 = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(t3, uid, 'Old')
  const s1 = fixture(5, ['Email'], t3), s2 = fixture(5, ['Email'], t3)
  const alone = trashSheet(uid, t3, s2)
  assert.ok('ok' in alone)
  const gone = trashTable(uid, t3)
  assert.ok('ok' in gone)
  purgeTrashItems(uid, [gone.ok.trashId])
  await waitGone(gone.ok.trashId)
  assert.ok(!exists('SELECT 1 FROM tables WHERE id = ?', t3))
  assert.ok(!exists('SELECT 1 FROM sheets WHERE id IN (?, ?)', s1, s2))
  assert.equal(item(alone.ok.trashId), undefined)
})

done()
