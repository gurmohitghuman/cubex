// Copying a sheet's values to a new sheet (lib/sheet-copy.ts,
// services/sheet-copy*.ts, migration 047). Pins: the pure parts (cells,
// columns, names); a copy goes right after its source with the source's rows
// in order at 0…n-1 under its columns, a run's words empty and unlisted keys
// left behind; a name taken or a busy source makes nothing; both sheets are
// held while the rows go in (the source can't be sorted, the copy can't be
// deleted; rows added to the source then aren't copied, even into the room a
// deleted last row left, rows added to the copy land after its range, and
// History says how many rows went in); a copy cut short by a restart goes on
// from its cursor without a row twice; a failed slice is tried again, and one
// that keeps failing stops the copy and says so.
// Over 200 lines: one fixture and the copy's scenarios, read top to bottom.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import pureMod from '../../server/src/lib/sheet-copy'
import copyMod from '../../server/src/services/sheet-copy'
import jobMod from '../../server/src/services/sheet-copy-job'
import busyMod from '../../server/src/lib/sheet-busy'
import rowsMod from '../../server/src/services/rows-write'
import helpersMod from '../../server/src/lib/sheet-crud-helpers'
import columnsMod from '../../server/src/lib/sheet-columns'
import trashMod from '../../server/src/services/trash-sheets'
import logMod from '../../server/src/lib/change-log'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { copiedCells, columnsToCopy, defaultCopyName } = pureMod as typeof import('../../server/src/lib/sheet-copy')
const { copySheetValues } = copyMod as typeof import('../../server/src/services/sheet-copy')
const { runSheetCopy, resumeSheetCopies, COPYING_INTO, BEING_COPIED } =
  jobMod as typeof import('../../server/src/services/sheet-copy-job')
const { sheetBusyWith, withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { appendRows } = rowsMod as typeof import('../../server/src/services/rows-write')
const { createSheetTxn } = helpersMod as typeof import('../../server/src/lib/sheet-crud-helpers')
const { appendColumnsToOrder } = columnsMod as typeof import('../../server/src/lib/sheet-columns')
const { trashSheet } = trashMod as typeof import('../../server/src/services/trash-sheets')
const { logSheetChange } = logMod as typeof import('../../server/src/lib/change-log')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
console.error = () => {}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }

const COLUMNS = ['Email', 'Name', 'Status', 'Score']
// A table holding "Leads" (n rows at positions 0, 3, 6…, every run word in
// some cell, a number, an unlisted key) and "Other" after it.
function fixture(n: number) {
  const tid = uuid(), src = uuid(), other = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, `T_${tid.slice(0, 8)}`)
  const sheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  sheet.run(src, tid, uid, 'Leads', 0, JSON.stringify(COLUMNS))
  sheet.run(other, tid, uid, 'Other', 1, '[]')
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const status = i % 5 === 0 ? '❌ Failed: timeout' : i % 11 === 0 ? ' ⏭️ Not found' : i % 13 === 0
        ? '➕ Adding 3 rows…' : '✅ Found'
      ins.run(uuid(), src, uid, i * 3, JSON.stringify({
        Email: i % 17 === 0 ? '' : `u${i}@acme.com`, Name: i % 7 === 0 ? '⏳ Processing...' : `N${i}`,
        Status: status, Score: i, Ghost: 'unlisted',
      }))
    }
  })()
  return { tid, src, other }
}
const rowsOf = (sid: string) => db.prepare(
  'SELECT row_index AS i, data FROM rows WHERE sheet_id = ? ORDER BY row_index',
).all(sid) as Array<{ i: number; data: string }>
const expectedOf = (src: string, columns = COLUMNS) =>
  rowsOf(src).map(r => JSON.stringify(copiedCells(JSON.parse(r.data), columns)))
const sheetOf = (sid: string) => db.prepare(`SELECT name, position, column_order, data_version AS v FROM sheets
  WHERE id = ?`).get(sid) as { name: string; position: number; column_order: string; v: number }
const jobs = () => db.prepare('SELECT * FROM sheet_copy_jobs').all() as Array<{ sheet_id: string }>

await ok('pure: cells, columns, names', () => {
  const data = { A: 'x', B: '⏳ Processing...', C: ' ❌ boom', D: '⏭️ Not found', E: '➕ Adding', F: 7, G: '', H: null }
  assert.deepEqual({ ...copiedCells(data, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Missing']) }, { A: 'x', F: 7 })
  assert.deepEqual({ ...copiedCells({ A: '1', B: '2' }, ['B']) }, { B: '2' }, 'only the chosen columns')
  const proto = copiedCells(JSON.parse('{"__proto__": "v"}'), ['__proto__'])
  assert.equal(Object.getPrototypeOf(proto), null)
  assert.equal(JSON.stringify(proto), '{"__proto__":"v"}', 'a column named __proto__ is a plain cell')
  assert.deepEqual(columnsToCopy(['A', 'B'], undefined), { ok: ['A', 'B'] })
  assert.deepEqual(columnsToCopy(['A', 'B', 'C'], ['C', 'A']), { ok: ['C', 'A'] }, 'in the order asked')
  for (const bad of [[], 'A', [1], ['A', 'A']]) assert.ok('error' in columnsToCopy(['A'], bad), JSON.stringify(bad))
  assert.match((columnsToCopy(['A'], ['Nope']) as { error: string }).error, /No column named "Nope"/)
  const taken = new Set(['copy of leads', 'copy of leads 2'])
  assert.equal(defaultCopyName('Leads', () => false), 'Copy of Leads')
  assert.equal(defaultCopyName('Leads', n => taken.has(n.toLowerCase())), 'Copy of Leads 3')
  const long = 'x'.repeat(99) + '😀'
  const fitted = defaultCopyName(long, n => n === defaultCopyName(long, () => false))
  assert.ok(fitted.length <= 100 && fitted.endsWith(' 2'), fitted)
  const cut = defaultCopyName('x'.repeat(91) + '😀😀', () => false)
  assert.ok(cut.isWellFormed() && cut.length <= 100, 'no half emoji')
})

await ok('a copy: after its source, rows in order at 0…n-1, values only, History, nothing left busy', async () => {
  const { tid, src, other } = fixture(12_000)
  const before = sheetOf(src)
  const out = await copySheetValues(uid, src)
  assert.ok('ok' in out, JSON.stringify(out))
  const dest = out.ok.sheet.id
  assert.equal(out.ok.sheet.name, 'Copy of Leads')
  assert.equal(out.ok.rowsCopied, 12_000)
  assert.deepEqual(out.ok.columns, COLUMNS)
  assert.deepEqual((out.ok.sheets as Array<{ id: string }>).map(s => s.id), [src, dest, other], 'right after it')
  assert.equal(sheetOf(other).position, 2)
  assert.deepEqual(JSON.parse(sheetOf(dest).column_order), COLUMNS)
  const copied = rowsOf(dest)
  assert.deepEqual(copied.map(r => r.i), copied.map((_, k) => k), 'positions 0…n-1')
  assert.deepEqual(copied.map(r => r.data), expectedOf(src), 'the same rows in order, a run\'s words empty')
  const all = copied.map(r => JSON.parse(r.data))
  assert.ok(all.every(d => !('Ghost' in d)), 'unlisted keys stay behind')
  assert.ok(all.some(d => d.Status === '✅ Found') && all.every(d => !String(d.Status ?? '').match(/[⏳❌⏭➕]/u)))
  assert.equal(all[1].Score, 1, 'a number stays a number')
  assert.deepEqual(sheetOf(src), before, 'the source is untouched')
  assert.ok(sheetOf(dest).v > 0, 'open tabs of the copy reload')
  assert.equal(jobs().length, 0, 'journal gone')
  assert.equal(sheetBusyWith(dest), null)
  assert.equal(sheetBusyWith(src), null)
  const log = db.prepare('SELECT action, summary FROM sheet_changes WHERE sheet_id = ?').all(dest) as
    Array<{ action: string; summary: string }>
  assert.deepEqual(log, [{ action: 'sheet_copied', summary: 'Copied the values of 12,000 rows from "Leads"' }])
  const views = db.prepare('SELECT COUNT(*) AS c FROM sheet_views WHERE sheet_id = ?').get(dest) as { c: number }
  assert.equal(views.c, 1, 'its own Default view')

  const second = await copySheetValues(uid, src, { columns: ['Status', 'Email'] })
  assert.ok('ok' in second, JSON.stringify(second))
  assert.equal(second.ok.sheet.name, 'Copy of Leads 2')
  assert.deepEqual(JSON.parse(sheetOf(second.ok.sheet.id).column_order), ['Status', 'Email'])
  assert.deepEqual(rowsOf(second.ok.sheet.id).map(r => r.data), expectedOf(src, ['Status', 'Email']))
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sheets WHERE table_id = ?').pluck().get(tid), 4)
})

await ok('a name taken, a bad name or column, a busy source: nothing made', async () => {
  const { tid, src } = fixture(10)
  const count = () => db.prepare('SELECT COUNT(*) FROM sheets WHERE table_id = ?').pluck().get(tid)
  const taken = await copySheetValues(uid, src, { name: ' other ' })
  assert.ok('fail' in taken && taken.fail === 'conflict', JSON.stringify(taken))
  for (const opts of [{ name: '' }, { name: 'a<b' }, { columns: ['Nope'] }, { columns: 'Email' }]) {
    const out = await copySheetValues(uid, src, opts)
    assert.ok('fail' in out && out.fail === 'bad_request', JSON.stringify(out))
  }
  const missing = await copySheetValues(uid, uuid())
  assert.ok('fail' in missing && missing.fail === 'not_found')
  let release!: () => void
  const held = withSheetBusy(src, 'sorting', () => new Promise<void>(r => { release = r }))
  const busy = await copySheetValues(uid, src)
  assert.ok('fail' in busy && busy.fail === 'busy' && /busy sorting/.test(busy.message), JSON.stringify(busy))
  release(); await held
  assert.equal(count(), 2)
  assert.equal(jobs().length, 0)
  const named = await copySheetValues(uid, src, { name: '  Leads   Oct 20 ' })
  assert.ok('ok' in named && named.ok.sheet.name === 'Leads Oct 20', JSON.stringify(named))
  const empty = fixture(0)
  const none = await copySheetValues(uid, empty.src)
  assert.ok('ok' in none && none.ok.rowsCopied === 0 && rowsOf(none.ok.sheet.id).length === 0)
})

await ok('while the rows go in: both sheets held, new rows on either side stay out of the copy', async () => {
  const { tid, src } = fixture(12_000)
  const expected = expectedOf(src)
  const running = copySheetValues(uid, src)
  const dest = jobs()[0].sheet_id
  assert.equal(sheetBusyWith(dest), COPYING_INTO)
  const sort = await withSheetBusy(src, 'sorting', async () => 'sorted')
  assert.deepEqual(sort, { busy: `This sheet is busy ${BEING_COPIED}. Try again when that finishes.` })
  assert.ok('fail' in trashSheet(uid, tid, dest), 'the copy can\'t be deleted meanwhile')
  // The last row goes, so rows added to the source land inside the range the copy reads.
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index = ?').run(src, 3 * 11_999)
  const intoSource = appendRows(src, uid, [{ Email: 'late@acme.com' }, { Email: 'later@acme.com' }])
  assert.ok('ok' in intoSource && intoSource.ok.rows[0].index < 3 * 11_999, JSON.stringify(intoSource))
  const intoCopy = appendRows(dest, uid, [{ Email: 'typed@acme.com' }])
  assert.ok('ok' in intoCopy, JSON.stringify(intoCopy))
  const out = await running
  assert.ok('ok' in out && out.ok.rowsCopied === 11_999, JSON.stringify(out))
  const copied = rowsOf(dest)
  assert.deepEqual(copied.slice(0, 11_999).map(r => r.data), expected.slice(0, 11_999),
    'the rows added to the source aren\'t copied, the deleted one is gone')
  assert.equal(copied.length, 12_000)
  assert.equal(copied[11_999].i, 12_000, 'a row added to the copy lands after its range')
  assert.equal(JSON.parse(copied[11_999].data).Email, 'typed@acme.com')
  const log = db.prepare('SELECT summary, detail FROM sheet_changes WHERE sheet_id = ?').get(dest) as
    { summary: string; detail: string }
  assert.equal(log.summary, 'Copied the values of 11,999 rows from "Leads"', 'History says what went in')
  assert.equal(JSON.parse(log.detail).rows, 11_999)
})

// A copy whose first `k` rows went in before a restart (the journal as a slice leaves it).
function cutShort(src: string, tid: string, k: number, name: string): string {
  const source = rowsOf(src)
  const made = createSheetTxn(tid, uid, name, src, { seed: false })
  assert.ok(made.ok)
  const dest = made.sheetId
  appendColumnsToOrder(dest, uid, COLUMNS)
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  source.slice(0, k).forEach((r, i) => ins.run(uuid(), dest, uid, i,
    JSON.stringify(copiedCells(JSON.parse(r.data), COLUMNS))))
  const changeId = logSheetChange(dest, uid, 'sheet_copied', `Copied the values of ${source.length} rows from "Leads"`,
    { detail: { from_sheet_id: src, from_name: 'Leads', rows: source.length } })
  const maxRowid = db.prepare('SELECT MAX(rowid) FROM rows').pluck().get()
  db.prepare(`INSERT INTO sheet_copy_jobs (sheet_id, user_id, source_sheet_id, columns, end_row, max_rowid,
    row_count, after_row, copied, change_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(dest, uid, src,
    JSON.stringify(COLUMNS), source[source.length - 1].i, maxRowid, source.length, k > 0 ? source[k - 1].i : null,
    k, changeId)
  return dest
}

await ok('a copy cut short by a restart goes on from its cursor, no row twice', async () => {
  const { tid, src } = fixture(9_000)
  const dest = cutShort(src, tid, 6_500, 'Resumed')
  resumeSheetCopies()
  assert.equal(sheetBusyWith(dest), COPYING_INTO, 'busy before any request')
  await idle(dest)
  assert.deepEqual(rowsOf(dest).map(r => r.data), expectedOf(src))
  assert.deepEqual(rowsOf(dest).map(r => r.i), rowsOf(dest).map((_, k) => k))
  assert.equal(jobs().length, 0)
  assert.equal(sheetBusyWith(src), null, 'the source is free again')
})

await ok('a failed slice is tried again; one that keeps failing stops the copy and says so', async () => {
  const { tid, src } = fixture(300)
  db.exec(`CREATE TEMP TRIGGER copy_fails BEFORE INSERT ON rows WHEN instr(NEW.data, 'u250@') > 0
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
  const running = copySheetValues(uid, src)
  const dest = jobs()[0].sheet_id
  assert.equal(rowsOf(dest).length, 0, 'the failed slice left nothing')
  db.exec('DROP TRIGGER copy_fails')
  const out = await running
  assert.ok('ok' in out && out.ok.rowsCopied === 300, JSON.stringify(out))
  assert.deepEqual(rowsOf(dest).map(r => r.data), expectedOf(src))

  const stuck = cutShort(src, tid, 100, 'Stuck')
  db.exec(`CREATE TEMP TRIGGER copy_fails BEFORE INSERT ON rows WHEN instr(NEW.data, 'u250@') > 0
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
  const end = await runSheetCopy(stuck, 1)
  db.exec('DROP TRIGGER copy_fails')
  assert.equal(end.copied, 100)
  assert.match(end.stopped ?? '', /disk I\/O error/)
  assert.equal(rowsOf(stuck).length, 100, 'it keeps the rows it has')
  assert.equal(jobs().length, 0, 'and its journal goes')
  const log = db.prepare('SELECT summary FROM sheet_changes WHERE sheet_id = ?').pluck().all(stuck) as string[]
  assert.deepEqual(log, ['Copying the values of "Leads" stopped after 100 rows of 300: disk I/O error'])
})

if (failures) { console.log(`\n${failures} failing`); process.exit(1) }
console.log('\nall sheet copy tests passed')
