// A CSV import and its undo against another connection writing at the worst
// moment (write-lock-kit.ts). Each transaction that reads before it writes
// takes the write lock first (.immediate()), so it waits its turn instead of
// failing with SQLITE_BUSY: a replace whose first trash slice met a held write
// lock used to fail and leave the sheet empty (its old rows in the trash, the
// setups of the columns the file lacked forgotten); one whose last step met a
// commit did the same; an append failed; an import's undo failed and kept the
// sheet busy (409) while it retried in the background.
import assert from 'node:assert/strict'
import importMod from '../../server/src/services/csv-import'
import parseMod from '../../server/src/lib/csv-import-parse'
import undoMod from '../../server/src/lib/import-undo'
import busyMod from '../../server/src/lib/sheet-busy'
import descMod from '../../server/src/services/descriptions'
import { attempt, fixture, rivalKit } from './write-lock-kit'
import { v4 as uuid } from 'uuid'
const { importCsv } = importMod as typeof import('../../server/src/services/csv-import')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')
const { undoOrKeepTrying } = undoMod as typeof import('../../server/src/lib/import-undo')
type ImportJob = import('../../server/src/lib/import-undo').ImportJob
const { sheetBusyWith, withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { describeColumn } = descMod as typeof import('../../server/src/services/descriptions')

const { db, uid, ok, done, sheet, cells, order, idle } = fixture('write lock: imports')
const rival = await rivalKit()
const HOLD_MS = 300
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ Email: `old${i}@x.com`, Name: `Old ${i}` }))
const describe = (s: string, column: string, text: string) =>
  assert.ok('ok' in describeColumn(s, uid, column, text))
const descriptions = (s: string) => Object.fromEntries(db.prepare(`SELECT column_name, description
  FROM column_descriptions WHERE sheet_id = ? ORDER BY column_name`).raw().all(s) as Array<[string, string]>)
const cleanColumns = (s: string) => db.prepare('SELECT column_name FROM clean_columns WHERE sheet_id = ?')
  .pluck().all(s) as string[]
const trash = (s: string) => db.prepare(`SELECT how, state, row_count FROM trash_items WHERE sheet_id = ?
  AND kind = 'rows'`).all(s)
// What a sheet holds, for a failure's message.
const left = (s: string) => JSON.stringify({
  rows: db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(s),
  columns: order(s), descriptions: descriptions(s), cleanColumns: cleanColumns(s), trash: trash(s),
  busy: sheetBusyWith(s),
})
const failed = (out: { threw: string } | object, s: string) =>
  'threw' in out ? `failed with ${out.threw}; the sheet was left ${left(s)}` : ''

await ok('a CSV replace waits for another connection holding the write lock; every row and setup lands', async () => {
  const S = sheet(['Email', 'Name', 'Note', 'Email clean'], people(5))
  describe(S, 'Email', 'Work email')
  describe(S, 'Note', 'Free text')
  db.prepare(`INSERT INTO clean_columns (id, user_id, sheet_id, column_name, source_column, cleaner, fill_status)
    VALUES (?, ?, ?, 'Email clean', 'Email', 'lowercase', 'done')`).run(uuid(), uid, S)
  const csv = await scanCsvText('Email,Name,Email clean\n'
    + 'a@x.com,Ann,a@x.com\nb@x.com,Bob,b@x.com\nc@x.com,Cy,c@x.com\n')
  const before = rival.writes()
  // Right after the first slice picked its rows, before its transaction starts.
  const pick = /^SELECT rowid FROM rows WHERE sheet_id = \? AND user_id = \? AND row_index >= \?/
  const shot = rival.arm({ inTx: false, sql: pick, hold: HOLD_MS })
  const out = await attempt(() => importCsv(S, uid, csv, true))
  const waited = Date.now() - shot.at
  await idle(S)
  await rival.settled()
  assert.equal(shot.outcome, 'raced', 'the rival held the write lock as the slice began')
  assert.ok('value' in out && 'ok' in out.value, `the replace ${failed(out, S)}`)
  assert.ok(waited >= HOLD_MS / 2, `it waited for the lock (${waited} ms)`)
  assert.equal(out.value.ok.rowsImported, 3)
  assert.deepEqual(cells(S, 'Email'), ['a@x.com', 'b@x.com', 'c@x.com'])
  assert.deepEqual(order(S), ['Email', 'Name', 'Email clean'])
  // Note's description goes with its column, as on any replace without it.
  assert.deepEqual(descriptions(S), { Email: 'Work email' })
  assert.deepEqual(cleanColumns(S), ['Email clean'])
  assert.deepEqual(trash(S), [{ how: 'import', state: 'kept', row_count: 5 }], 'the old rows, restorable')
  assert.equal(rival.writes(), before + 1, "the rival's write landed too")
})

await ok("a CSV replace whose last step meets another connection's commit still lands", async () => {
  const S = sheet(['Email', 'Name'], people(4))
  describe(S, 'Name', 'Full name')
  const shot = rival.arm({ inTx: true, sql: /^SELECT 1 FROM rows WHERE sheet_id = \? AND user_id = \? LIMIT 1$/ })
  const out = await attempt(async () => importCsv(S, uid, await scanCsvText('Email,Name\nd@x.com,Di\n'), true))
  await idle(S)
  await rival.settled()
  assert.ok('value' in out && 'ok' in out.value, `the replace ${failed(out, S)}`)
  assert.equal(shot.outcome, 'blocked', 'its last step held the write lock from its start')
  assert.deepEqual(cells(S, 'Name'), ['Di'])
  assert.deepEqual(descriptions(S), { Name: 'Full name' })
})

await ok("an append import meeting another connection's commit still lands", async () => {
  const S = sheet(['Email'], [{ Email: 'p@x.com' }, { Email: 'q@x.com' }])
  const shot = rival.arm({ inTx: true })
  const out = await attempt(async () => importCsv(S, uid, await scanCsvText('Email\nr@x.com\n'), false))
  await idle(S)
  await rival.settled()
  assert.ok('value' in out && 'ok' in out.value, `the append ${failed(out, S)}`)
  assert.equal(shot.outcome, 'blocked', 'its journal step held the write lock from its start')
  assert.deepEqual(cells(S, 'Email'), ['p@x.com', 'q@x.com', 'r@x.com'])
})

await ok("an import's undo meeting another connection's commit finishes at once", async () => {
  // A replace cut short once its rows were in: the undo empties the sheet.
  const S = sheet(['Email', 'Name'], people(4))
  db.prepare(`INSERT INTO import_jobs (sheet_id, user_id, is_replace, first_row, end_row, columns)
    VALUES (?, ?, 1, 0, 4, '["Email"]')`).run(S, uid)
  const job = db.prepare('SELECT * FROM import_jobs WHERE sheet_id = ?').get(S) as ImportJob
  const shot = rival.arm({ inTx: true, sql: /^SELECT DISTINCT je\.key FROM rows r, json_each/ })
  const out = await attempt(() => withSheetBusy(S, 'importing', async reserve => {
    reserve(job.end_row)
    await undoOrKeepTrying(job)
  }))
  const busy = sheetBusyWith(S)
  await idle(S)
  await rival.settled()
  assert.ok('value' in out, `the undo failed with ${'threw' in out ? out.threw : ''}; meanwhile the sheet `
    + `answered busy (409) as "${busy}" until a retry finished it`)
  assert.equal(shot.outcome, 'blocked', 'its last step held the write lock from its start')
  assert.equal(busy, null, 'the sheet is free at once')
  assert.equal(db.prepare('SELECT COUNT(*) FROM import_jobs WHERE sheet_id = ?').pluck().get(S), 0)
  assert.deepEqual(order(S), ['Email'])
  assert.deepEqual(cells(S, 'Email'), [''], 'one row to type into')
})

await rival.stop()
done()
