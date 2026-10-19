// Over 200 lines: one scenario per issue edge, each needing its own sheet setup; split they'd share the setup.
// Auto-dedupe's edges against a real database (services/auto-dedupe-*.ts).
// Pins: saving the setting again keeps phone_country while the column and
// match stay (null clears it); a sheet in the trash gets no background checks
// or key builds, and they go through once it is restored; an answer lists at
// most AUTO_DEDUPE_LIST_IDS seqs and names the rest as ranges (transfer_rows);
// rows a list job adds are checked; rows arriving while a CSV replace is under
// way wait for it; a replace keeping the key column checks its rows, one
// without it (or deleting the column) turns auto-dedupe off; a build or drain
// step that read the setting before its key column was renamed stops instead
// of dropping keys.
// Over 200 lines: one fixture and its scenarios, read top to bottom.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import settingMod from '../../server/src/services/auto-dedupe-setting'
import indexMod from '../../server/src/services/auto-dedupe-index'
import checksMod from '../../server/src/services/auto-dedupe-checks'
import rowsMod from '../../server/src/services/rows-write'
import renameMod from '../../server/src/services/column-rename'
import deleteMod from '../../server/src/services/column-delete'
import trashMod from '../../server/src/services/trash-sheets'
import actionsMod from '../../server/src/services/trash-actions'
import transferMod from '../../server/src/services/rows-transfer'
import listMod from '../../server/src/services/enrich-list-add'
import importMod from '../../server/src/services/csv-import'
import parseMod from '../../server/src/lib/csv-import-parse'
import busyMod from '../../server/src/lib/sheet-busy'
import storeMod from '../../server/src/lib/auto-dedupe/store'
import constMod from '../../server/src/lib/constants-dedupe'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { setAutoDedupe, autoDedupeView } = settingMod as typeof import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet, buildStep, drainStep } =
  indexMod as typeof import('../../server/src/services/auto-dedupe-index')
const { runChecks } = checksMod as typeof import('../../server/src/services/auto-dedupe-checks')
const { appendRows } = rowsMod as typeof import('../../server/src/services/rows-write')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { trashSheet } = trashMod as typeof import('../../server/src/services/trash-sheets')
const { restoreFromTrash } = actionsMod as typeof import('../../server/src/services/trash-actions')
const { transferRows } = transferMod as typeof import('../../server/src/services/rows-transfer')
const { addListItems } = listMod as typeof import('../../server/src/services/enrich-list-add')
const { importCsv } = importMod as typeof import('../../server/src/services/csv-import')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { autoDedupeOf } = storeMod as typeof import('../../server/src/lib/auto-dedupe/store')
const { AUTO_DEDUPE_LIST_IDS } = constMod as typeof import('../../server/src/lib/constants-dedupe')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

let position = 0
function sheet(name: string, columns: string[], rows: Array<Record<string, string>>): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, position, column_order) VALUES (?,?,?,?,?,?)')
    .run(id, tid, uid, name, position++, JSON.stringify(columns))
  const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  rows.forEach((r, i) => ins.run(uuid(), id, uid, i, JSON.stringify(r)))
  return id
}
const cells = (s: string, c: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(s) as string[]).map(d => JSON.parse(d)[c] ?? '')
const keyCount = (s: string) => db.prepare(`SELECT COUNT(*) FROM auto_dedupe_keys k JOIN auto_dedupe a
  ON a.id = k.dedupe_id WHERE a.sheet_id = ?`).pluck().get(s) as number
const waiting = (s: string) => db.prepare(`SELECT COUNT(*) FROM auto_dedupe_checks c JOIN auto_dedupe a
  ON a.id = c.dedupe_id WHERE a.sheet_id = ?`).pluck().get(s) as number
const ready = async (s: string) => assert.equal(await maintainAutoDedupeSheet(s, uid, Date.now() + 10_000), 'ready')
const checks = (s: string) => runChecks(s, uid, { ownBusy: false, deadline: Date.now() + 5_000 })
function on(s: string, args: Record<string, unknown>) {
  const out = setAutoDedupe(uid, s, args)
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok
}
const idle = async (s: string) => { while (sheetBusyWith(s)) await new Promise(r => setTimeout(r, 5)) }

async function main() {
  await ok('saving the setting again keeps phone_country while column and match stay; null clears it', async () => {
    const P = sheet('Phones', ['Phone'], [{ Phone: '+44 20 7946 0958' }])
    on(P, { column: 'Phone', match: 'phone', phone_country: 'GB' })
    await ready(P)
    const id = autoDedupeOf(P, uid)!.id
    // What the app sends: column, match and keep, without the country.
    assert.equal(on(P, { column: 'Phone', match: 'phone', keep: 'newest' }).phone_country, 'GB')
    assert.equal(autoDedupeOf(P, uid)!.id, id, 'only keep changed: no new setting, no rebuild')
    assert.equal(on(P, { keep: 'oldest' }).phone_country, 'GB')
    const out = appendRows(P, uid, [{ Phone: '020 7946 0958' }])
    assert.ok('ok' in out && out.ok.deduped!.removed.length === 1, 'a UK number without +44 matches (read as GB)')
    assert.equal(on(P, { column: 'Phone', match: 'phone', phone_country: null }).phone_country, null)
    on(P, { phone_country: 'GB' })
    assert.equal(on(P, { match: 'text' }).phone_country, null, 'another match drops it')
  })

  await ok('a sheet in the trash: no checks, no key build; restored, they go through', async () => {
    const S = sheet('Trashed', ['Email'], Array.from({ length: 30 }, (_, i) => ({ Email: `u${i}@x.com` })))
    assert.equal(on(S, { column: 'Email', match: 'email' }).state, 'building')
    const out = appendRows(S, uid, [{ Email: 'u3@x.com' }])
    assert.ok('ok' in out && out.ok.deduped!.waiting === 1)
    const t = trashSheet(uid, tid, S)
    assert.ok('ok' in t && t.ok.trashId !== null, JSON.stringify(t))
    await ready(S)
    assert.notEqual(autoDedupeOf(S, uid)!.build_cursor, null, 'the build waits for the restore')
    const r = await checks(S)
    assert.equal(r.removed, 0)
    assert.equal(r.stopped, 'held')
    assert.equal(cells(S, 'Email').length, 31)
    assert.equal(waiting(S), 1, 'its check stays queued')
    const back = await restoreFromTrash(uid, [t.ok.trashId!])
    assert.ok(back.every(b => 'ok' in b || (b as { state?: string }).state !== 'failed'), JSON.stringify(back))
    await ready(S)
    assert.equal(autoDedupeOf(S, uid)!.build_cursor, null)
    await checks(S)
    assert.equal(cells(S, 'Email').length, 30)
    assert.equal(waiting(S), 0)
  })

  await ok('transfer_rows: checked, and the answer lists at most 100 seqs with ranges for all', async () => {
    const many = 150
    const src = sheet('Src', ['Email'], Array.from({ length: many }, () => ({ Email: 'same@x.com' })))
    const dest = sheet('Dest', ['Email'], [{ Email: 'SAME@x.com' }])
    on(dest, { column: 'Email', match: 'email' })
    await ready(dest)
    const out = transferRows(uid, {
      sourceSheetId: src, destinationSheetId: dest, operation: 'copy', selection: { all: true },
      columnMode: 'require_existing', columnModeOmitted: false, columnMapping: {}, idempotencyKey: uuid(),
    }, 'mcp')
    assert.ok('ok' in out, JSON.stringify(out))
    const a = out.ok.auto_dedupe!
    assert.equal(a.not_kept_count, many)
    assert.equal(a.not_kept.length, AUTO_DEDUPE_LIST_IDS)
    assert.equal(a.trash!.seqs.length, AUTO_DEDUPE_LIST_IDS)
    assert.equal(a.trash!.seqs_count, many)
    const ranges = a.trash!.seq_ranges!
    assert.equal(ranges.reduce((n, [lo, hi]) => n + hi - lo + 1, 0), many)
    assert.equal(ranges[0][0], a.trash!.seqs[0])
    assert.match(a.trash!.how_to_restore, /seq_ranges/)
    assert.deepEqual(cells(dest, 'Email'), ['SAME@x.com'])
  })

  await ok('rows a list job adds are checked: one the sheet has is not added again', async () => {
    const src = sheet('Leads', ['Company', 'People'], [{ Company: 'Co', People: '➕ Adding 2 rows…' }])
    const srcRow = db.prepare('SELECT id FROM rows WHERE sheet_id = ?').pluck().get(src) as string
    const dest = sheet('People', ['Company', 'Name'], [{ Company: 'Co', Name: 'Ann' }])
    on(dest, { column: 'Name' })
    await ready(dest)
    const run = uuid()
    const list = {
      destSheetId: dest, itemsPath: '$.output.people', provider: null, maxItems: 10,
      fields: [{ path: '$.name', columnName: 'Name' }], copy: [{ id: 'c1', from: 'Company', to: 'Company' }],
      dedupe: null,
    }
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
      dest_sheet_id) VALUES (?, ?, ?, ?, 'completed', 0, 'People', ?)`).run(run, src, uid,
      JSON.stringify({ requestConfig: {}, responseMapping: [], enrichment: { v: 1, list } }), dest)
    const journal = uuid()
    db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
      dest_sheet_id, items_json, item_count) VALUES (?,?,?,?,?,?,?,?)`).run(journal, uid, run, src, srcRow, dest,
      JSON.stringify({ items: [{ name: 'ann' }, { name: 'Bob' }], copy: { c1: 'Co' } }), 2)
    const out = addListItems(journal)
    assert.ok('added' in out && out.added === 1 && out.skipped === 1, JSON.stringify(out))
    assert.deepEqual(cells(dest, 'Name'), ['Ann', 'Bob'])
  })

  const R = sheet('Replace', ['Email', 'Name'], [{ Email: 'a@x.com' }, { Email: 'b@x.com' }])
  await ok('a row arriving while a CSV replace is under way waits for it', async () => {
    on(R, { column: 'Email', match: 'email' })
    await ready(R)
    db.prepare(`INSERT INTO import_jobs (sheet_id, user_id, is_replace, first_row, end_row, columns)
      VALUES (?, ?, 1, 0, 2, '["Email"]')`).run(R, uid)
    const out = appendRows(R, uid, [{ Email: 'a@x.com', Name: 'during' }])
    assert.ok('ok' in out, JSON.stringify(out))
    assert.equal(out.ok.deduped!.removed.length, 0)
    assert.equal(out.ok.deduped!.waiting, 1)
    db.prepare('DELETE FROM import_jobs WHERE sheet_id = ?').run(R)
    assert.equal((await checks(R)).removed, 1)
    assert.deepEqual(cells(R, 'Name'), ['', ''])
  })

  await ok('a CSV replace keeping the key column checks its rows; the setting stays', async () => {
    const csv = await scanCsvText('Email,Name\na@x.com,1\nA@X.com,2\nc@x.com,3\n')
    const out = await importCsv(R, uid, csv, true)
    assert.ok('ok' in out, JSON.stringify(out))
    await idle(R)
    assert.equal(out.ok.autoDedupe!.notKept, 1)
    assert.deepEqual(cells(R, 'Email'), ['a@x.com', 'c@x.com'])
    assert.equal(autoDedupeView(R, uid)!.column, 'Email')
  })

  await ok('a CSV replace without the key column turns auto-dedupe off', async () => {
    const out = await importCsv(R, uid, await scanCsvText('Name\nx\n'), true)
    assert.ok('ok' in out, JSON.stringify(out))
    await idle(R)
    assert.equal(out.ok.autoDedupe, null)
    assert.equal(autoDedupeView(R, uid), null)
  })

  await ok('deleting the key column turns auto-dedupe off; its keys and checks go', async () => {
    const D = sheet('Delete', ['Email', 'Name'], [{ Email: 'd@x.com' }, { Email: 'e@x.com' }])
    on(D, { column: 'Email', match: 'email' })
    await ready(D)
    const id = autoDedupeOf(D, uid)!.id
    const out = await deleteSheetColumn(D, uid, 'Email')
    assert.ok('ok' in out, JSON.stringify(out))
    assert.equal(autoDedupeView(D, uid), null)
    assert.ok(db.prepare('SELECT 1 FROM auto_dedupe_purges WHERE dedupe_id = ?').get(id), 'its keys are purged')
    const kept = appendRows(D, uid, [{ Name: 'n' }])
    assert.ok('ok' in kept && kept.ok.deduped === null)
  })

  await ok('a build or drain step that read the setting before a rename stops: no key is lost', async () => {
    const K = sheet('Rename', ['Email'], Array.from({ length: 10 }, (_, i) => ({ Email: `k${i}@x.com` })))
    on(K, { column: 'Email', match: 'email' })
    await ready(K)
    assert.equal(keyCount(K), 10)
    const stale = autoDedupeOf(K, uid)!
    assert.ok('ok' in await renameSheetColumn(K, uid, 'Email', 'Mail'))
    db.prepare('INSERT OR IGNORE INTO auto_dedupe_dirty (dedupe_id, rid) SELECT ?, rowid FROM rows WHERE sheet_id = ?')
      .run(stale.id, K)
    assert.equal(drainStep(stale), true)
    assert.equal(keyCount(K), 10, 'the stale drain read nothing under the old name')
    await ready(K)
    assert.equal(keyCount(K), 10)
    db.prepare('UPDATE auto_dedupe SET build_cursor = 0 WHERE id = ?').run(stale.id)
    const building = autoDedupeOf(K, uid)!
    assert.ok('ok' in await renameSheetColumn(K, uid, 'Mail', 'Email'))
    assert.equal(buildStep(building), true)
    assert.equal(keyCount(K), 10)
    assert.equal(autoDedupeOf(K, uid)!.build_cursor, 0)
    await ready(K)
    assert.equal(keyCount(K), 10)
    const out = appendRows(K, uid, [{ Email: 'k4@x.com' }])
    assert.ok('ok' in out && out.ok.deduped!.removed.length === 1)
  })

  console.log(failures === 0 ? '\nauto-dedupe edges: all passed' : `\nauto-dedupe edges: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
