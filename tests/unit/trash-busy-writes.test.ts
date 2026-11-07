// Heavy changes that check their sheet, then wait before they hold it, write
// nothing into a sheet that went to the trash (alone or with its table)
// meanwhile (withLiveSheetBusy): a CSV import while the file uploaded to an
// upload link or was scanned (the app, REST and MCP), a duplicate removal while
// a running check stopped, and a column rename while its formulas were checked.
// Each goes through once the sheet is restored.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
import sheetsMod from '../../server/src/services/trash-sheets'
import restoreMod from '../../server/src/services/trash-restore-sheet'
import importMod from '../../server/src/services/csv-import'
import uploadMod from '../../server/src/services/csv-upload'
import parseMod from '../../server/src/lib/csv-import-parse'
import uploadsMod from '../../server/src/lib/uploads'
import dedupeMod from '../../server/src/services/dedupe-remove'
import checkMod from '../../server/src/services/dedupe-check'
import renameMod from '../../server/src/services/column-rename'
import helpersMod from '../../server/src/lib/sql-helpers'
const { trashSheet, trashTable } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { restoreSheetItem } = restoreMod as typeof import('../../server/src/services/trash-restore-sheet')
const { importCsv } = importMod as typeof import('../../server/src/services/csv-import')
const { importUploadedCsv } = uploadMod as typeof import('../../server/src/services/csv-upload')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')
const { prepareUploadDir } = uploadsMod as typeof import('../../server/src/lib/uploads')
const { removeDuplicates } = dedupeMod as typeof import('../../server/src/services/dedupe-remove')
const { checkDuplicates } = checkMod as typeof import('../../server/src/services/dedupe-check')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { verifySheetOwnership } = helpersMod as typeof import('../../server/src/lib/sql-helpers')
const { db, uid, ok, done, fixture, rowsOf, idle } = trashKit('trash-busy-writes')
console.error = () => {}
prepareUploadDir()

type Place = { table: string; sid: string }
// A sheet of n rows in a table of its own, with a spare sheet beside it so it can go alone.
const place = (n = 3): Place => {
  const table = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(table, uid, `T_${table.slice(0, 8)}`)
  const sid = fixture(n, ['Email', 'Name'], table)
  fixture(1, ['Email', 'Name'], table)
  return { table, sid }
}
const HOWS = [['sheet', 'deleted alone'], ['table', 'deleted with its table']] as const
const trash = (how: 'sheet' | 'table', p: Place): number => {
  const out = how === 'sheet' ? trashSheet(uid, p.table, p.sid) : trashTable(uid, p.table)
  assert.ok('ok' in out && out.ok.trashId, JSON.stringify(out))
  return out.ok.trashId!
}
const restore = (id: number) => { const r = restoreSheetItem(uid, id); assert.ok('ok' in r, JSON.stringify(r)) }
const count = (sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number
// What a write would change: the rows, the column list, the fence, a rows batch, an import's journal.
const snapshot = (sid: string) => ({
  rows: rowsOf(sid),
  sheet: db.prepare('SELECT column_order, row_generation FROM sheets WHERE id = ?').get(sid),
  batches: count("SELECT COUNT(*) FROM trash_items WHERE sheet_id = ? AND kind = 'rows'", sid),
  journals: count('SELECT COUNT(*) FROM import_jobs WHERE sheet_id = ?', sid),
})
const CSV = 'Email,Company\nnew1@a.com,Acme\nnew2@a.com,Initech\n'
// The file arrives in two parts, `meanwhile` running between them.
const uploading = (meanwhile: () => void) => Readable.from((async function* () {
  yield Buffer.from(CSV.slice(0, 20))
  meanwhile()
  yield Buffer.from(CSV.slice(20))
})())
const GONE = { fail: 'sheet_not_found', error: 'Sheet not found' }
const BY_EMAIL = { columns: [{ column: 'Email', match: 'email' }] }

for (const [how, words] of HOWS) {
  for (const replace of [false, true]) {
    const mode = replace ? 'replace' : 'append'
    await ok(`an upload link's ${mode} writes nothing into a sheet ${words} while the file uploaded`, async () => {
      const p = place()
      const before = snapshot(p.sid)
      let id = 0
      const out = await importUploadedCsv(uploading(() => { id = trash(how, p) }), p.sid, uid, replace)
      assert.deepEqual(out, GONE)
      await idle(p.sid)
      assert.deepEqual(snapshot(p.sid), before, 'nothing was imported')
      restore(id)
      const back = await importUploadedCsv(Readable.from([Buffer.from(CSV)]), p.sid, uid, replace)
      assert.ok('ok' in back && back.ok.rowsImported === 2, JSON.stringify(back))
    })

    await ok(`a scanned ${mode} (the app, REST, MCP) writes nothing into a sheet ${words} meanwhile`, async () => {
      const p = place()
      assert.ok(verifySheetOwnership(p.sid, uid), "the route's check passes")
      const scanned = await scanCsvText(CSV)
      const id = trash(how, p)              // while the file was scanned
      const before = snapshot(p.sid)
      assert.deepEqual(await importCsv(p.sid, uid, scanned, replace, { bumpDataVersion: true }), GONE)
      assert.deepEqual(snapshot(p.sid), before, 'nothing was imported')
      restore(id)
      const back = await importCsv(p.sid, uid, await scanCsvText(CSV), replace, { bumpDataVersion: true })
      assert.ok('ok' in back && back.ok.rowsImported === 2, JSON.stringify(back))
    })
  }

  await ok(`a duplicate removal removes nothing from a sheet ${words} while a check stopped`, async () => {
    const p = place(10)                     // u0…u6, then u0, u1, u2 again
    const before = snapshot(p.sid)
    const check = checkDuplicates(uid, p.sid, BY_EMAIL)       // reading the sheet
    const removal = removeDuplicates(uid, p.sid, BY_EMAIL)    // stops it and waits for it...
    const id = trash(how, p)                                  // ...while the sheet goes to the trash
    assert.deepEqual(await removal, { fail: 'not_found', message: 'Sheet not found' })
    await check
    await idle(p.sid)
    assert.deepEqual(snapshot(p.sid), before, 'nothing was removed')
    restore(id)
    const back = await removeDuplicates(uid, p.sid, BY_EMAIL)
    assert.ok('ok' in back && back.ok.removed === 3, JSON.stringify(back))
  })

  await ok(`a column rename changes nothing in a sheet ${words} while its formulas were checked`, async () => {
    const p = place()
    const before = snapshot(p.sid)
    const rename = renameSheetColumn(p.sid, uid, 'Name', 'Full name')   // waits on the formula check...
    const id = trash(how, p)                                            // ...while the sheet goes
    assert.deepEqual(await rename, GONE)
    await idle(p.sid)
    assert.deepEqual(snapshot(p.sid), before, 'the column kept its name')
    restore(id)
    assert.deepEqual(await renameSheetColumn(p.sid, uid, 'Name', 'Full name'), { ok: true, newName: 'Full name' })
    assert.equal(JSON.parse(rowsOf(p.sid)[0].data)['Full name'], 'N0')
  })
}

done()
