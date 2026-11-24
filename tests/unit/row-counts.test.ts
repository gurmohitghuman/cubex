// Over 200 lines: one fixture, and the count's cases read in order (made, kept, changed, raced, restarted, waited for).
// Row counts made off the request (server/src/lib/row-counts.ts, services/table-row-counts.ts), on a migrated
// throwaway database:
//   - the home's list reads no row, and its counts follow once made; a count stays known while nothing changes,
//     and is kept in sheets.counted_rows;
//   - each way rows are added or removed (REST append and delete, the grid's delete, a CSV append and replace from
//     the app, a restore from the trash, a column added to an empty sheet) marks the count as updating, and the new
//     count is exact, including the ways that move neither data_version nor row_generation;
//   - rows removed during a count make it count again; rows that keep changing end it after ROW_COUNT_TRIES, and it
//     is made again when next asked;
//   - after a restart the last kept count shows as updating, then the new one;
//   - the kept count waits for another connection's write lock, written once it is let go;
//   - GET /v1/tables and list_tables wait for a count up to ROW_COUNT_API_WAIT_MS, then answer the last count with
//     row_count_updating: true; the home's wait answers once its counts are made;
//   - migration 063 counts every sheet's rows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import type BetterSqlite from 'better-sqlite3'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const Database = createRequire(path.resolve('server/src/queue.ts'))('better-sqlite3') as typeof BetterSqlite
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const counts = await import('../../server/src/lib/row-counts')
const { liveSheets, homeCounts, homeCountsWhenMade } = await import('../../server/src/services/table-row-counts')
const { listTablesWithSheets } = await import('../../server/src/services/workspace-read')
const { createTable } = await import('../../server/src/services/table-crud')
const { appendRows, deleteRowsByIds } = await import('../../server/src/services/rows-write')
const { deleteRowsToTrash } = await import('../../server/src/services/trash-rows')
const { importCsv } = await import('../../server/src/services/csv-import')
const { scanCsvText } = await import('../../server/src/lib/csv-import-parse')
const { restoreFromTrash } = await import('../../server/src/services/trash-actions')
const { addSheetColumn } = await import('../../server/src/services/column-add')
const { ROW_COUNT_API_WAIT_MS, ROW_COUNT_SLICE_ROWS, ROW_COUNT_TRIES } =
  await import('../../server/src/lib/constants-row-counts')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
const { rowsChanged } = await import('../../server/src/lib/rows-changed')
const { rowCounts, rowCountsNow, countsMade, forgetRowCounts, setRowCountSlices, rowCountWritesWaiting } = counts
runMigrations()
console.warn = () => {}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let failures = 0
const ok = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
  finally { setRowCountSlices(ROW_COUNT_SLICE_ROWS, null) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
function newSheet(rows: number): string {
  const t = createTable(uid, `T ${uuid().slice(0, 8)}`)
  if (!('ok' in t)) throw new Error(JSON.stringify(t))
  addSheetColumn(t.ok.sheetId, uid, 'Name', { seedEmptyRow: false })
  if (rows > 0) {
    const out = appendRows(t.ok.sheetId, uid, Array.from({ length: rows }, (_, i) => ({ Name: `r${i}` })))
    assert.ok('ok' in out, JSON.stringify(out))
  }
  return t.ok.sheetId
}
const real = (id: string) => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(id) as number
const kept = (id: string) => db.prepare('SELECT counted_rows FROM sheets WHERE id = ?').pluck().get(id) as number
const mine = (id: string) => liveSheets(uid).filter(s => s.id === id)
const ask = (id: string) => rowCounts(uid, mine(id)).get(id)!
const made = async (id: string) => {
  await countsMade([id], Date.now() + 10_000)
  return rowCountsNow(mine(id)).get(id)!
}
// Asked for and made: the count known from here on.
const fresh = async (id: string) => { ask(id); return made(id) }
const ids = (id: string) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(id) as string[]
async function until(what: string, test: () => boolean): Promise<void> {
  const t0 = Date.now()
  while (!test()) {
    if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

await ok('the home reads no row on its request; the count follows, stays known and is kept', async () => {
  const s = newSheet(5)
  const read: string[] = []
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => { read.push(sql); return prepare(sql) }) as typeof db.prepare
  let first
  try { first = homeCounts(uid, liveSheets(uid)) } finally { db.prepare = prepare }
  assert.deepEqual(read.filter(q => /\bFROM\s+rows\b/i.test(q)), [], 'statements reading rows on the request')
  const t = db.prepare('SELECT table_id FROM sheets WHERE id = ?').pluck().get(s) as string
  assert.deepEqual(first.get(t), { id: t, row_count: 0, row_count_updating: true })
  assert.deepEqual(await made(s), { rows: 5, updating: false })
  assert.deepEqual(ask(s), { rows: 5, updating: false }, 'asked again with nothing changed')
  await until('the count kept', () => rowCountWritesWaiting() === 0)
  assert.equal(kept(s), 5)
})

await ok('each way rows are added or removed marks the count as updating; the new count is exact', async () => {
  const s = newSheet(6)
  await fresh(s)
  const ways: Array<[string, () => Promise<unknown> | unknown]> = [
    ['REST append', () => appendRows(s, uid, [{ Name: 'a' }, { Name: 'b' }])],
    ['REST delete (to the trash)', () => deleteRowsByIds(s, uid, ids(s).slice(0, 2))],
    ['the grid\'s delete', () => db.transaction(() => deleteRowsToTrash(s, uid, 'grid', { indexes: [3] })).immediate()],
    ['a CSV append from the app', async () => importCsv(s, uid, await scanCsvText('Name\nx\ny\nz\n'), false)],
    ['a restore from the trash', async () => {
      const item = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND kind = 'rows' AND state = 'kept'
        ORDER BY id DESC LIMIT 1`).pluck().get(s) as number
      return restoreFromTrash(uid, [item])
    }],
    ['a CSV replace from the app', async () => importCsv(s, uid, await scanCsvText('Name\nonly\n'), true)],
  ]
  for (const [way, act] of ways) {
    const mark = db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ?').get(s)
    const before = real(s)
    await act()
    assert.notEqual(real(s), before, `${way} changed no row`)
    assert.equal(ask(s).updating, true, `${way}: the count is marked as updating`)
    assert.deepEqual(await made(s), { rows: real(s), updating: false }, way)
    const moved = JSON.stringify(db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ?').get(s))
    if (moved === JSON.stringify(mark)) console.log(`      ${way}: moved neither data_version nor row_generation`)
  }
  const empty = newSheet(0)
  assert.deepEqual(await fresh(empty), { rows: 0, updating: false })
  addSheetColumn(empty, uid, 'Email')
  assert.equal(real(empty), 1, 'a column added to an empty sheet adds row 0')
  assert.equal(ask(empty).updating, true, 'the column\'s row 0 marks the count')
  assert.deepEqual(await made(empty), { rows: 1, updating: false })
})

await ok('rows removed during a count make it count again', async () => {
  const s = newSheet(10)
  let slices = 0
  setRowCountSlices(3, () => {
    if (slices++ === 0) deleteRowsByIds(s, uid, [ids(s)[0]])
  })
  ask(s)
  assert.deepEqual(await made(s), { rows: 9, updating: false })
  assert.equal(real(s), 9)
  assert.ok(slices > 3, `${slices} slices: counted once only (10 rows in slices of 3 is 3 slices before the last)`)
  setRowCountSlices(ROW_COUNT_SLICE_ROWS, null)
  assert.deepEqual(ask(s), { rows: 9, updating: false }, 'known once made again')
})

await ok(`rows that keep changing: the count ends after ${ROW_COUNT_TRIES} tries, made again when asked`, async () => {
  const s = newSheet(10)
  let passes = 0
  // Its rows marked as changed after every slice but the last (two of three, in slices of 5), none added.
  setRowCountSlices(5, () => { passes++; rowsChanged(s) })
  ask(s)
  const answer = await made(s)
  assert.equal(passes, ROW_COUNT_TRIES * 2, 'two slices before the last, in each try')
  assert.equal(answer.updating, false, 'answered once its tries are over')
  setRowCountSlices(ROW_COUNT_SLICE_ROWS, null)
  assert.equal(ask(s).updating, true, 'counted again when next asked: its rows changed during the count')
  assert.deepEqual(await made(s), { rows: real(s), updating: false })
})

await ok('after a restart, the last kept count shows as updating, then the new one', async () => {
  const s = newSheet(4)
  await fresh(s)
  await until('the count kept', () => rowCountWritesWaiting() === 0)
  forgetRowCounts()
  assert.deepEqual(ask(s), { rows: 4, updating: true })
  assert.deepEqual(await made(s), { rows: 4, updating: false })
  assert.equal(rowCountWritesWaiting(), 0, 'the same count isn\'t written again')
})

await ok('the kept count waits for another connection\'s write lock, written once it is let go', async () => {
  const s = newSheet(2)
  await fresh(s)
  await until('the count kept', () => rowCountWritesWaiting() === 0)
  appendRows(s, uid, [{ Name: 'c' }])
  const other = new Database(process.env.DB_PATH!)
  other.exec('BEGIN IMMEDIATE')
  try {
    other.prepare("UPDATE users SET password_hash = 'y' WHERE id = ?").run(uid)
    ask(s)
    assert.deepEqual(await made(s), { rows: 3, updating: false }, 'counted under the lock')
    await sleep(300)
    assert.equal(rowCountWritesWaiting(), 1, 'its write waits')
    assert.equal(kept(s), 2)
  } finally {
    other.exec('COMMIT')
    other.close()
  }
  await until('the count written once the lock is let go', () => rowCountWritesWaiting() === 0)
  assert.equal(kept(s), 3)
})

await ok('REST and MCP wait for a count up to the cap; the home\'s wait answers once its counts are made', async () => {
  const s = newSheet(6)
  await fresh(s)
  appendRows(s, uid, [{ Name: 'n' }])
  const sheetOf = async () => (await listTablesWithSheets(uid)).flatMap(t => t.sheets).find(x => x.id === s)!
  assert.deepEqual(await sheetOf(), { id: s, name: 'Sheet1', position: 0, row_count: 7 }, 'a count made in time')
  appendRows(s, uid, [{ Name: 'o' }])
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  setRowCountSlices(2, () => held)
  const t0 = Date.now()
  const late = await sheetOf()
  const took = Date.now() - t0
  assert.deepEqual(late, { id: s, name: 'Sheet1', position: 0, row_count: 7, row_count_updating: true })
  assert.ok(took >= ROW_COUNT_API_WAIT_MS - 50 && took < ROW_COUNT_API_WAIT_MS + 1000, `waited ${took} ms`)
  let answered = false
  const home = homeCountsWhenMade(uid).then(a => { answered = true; return a })
  await sleep(200)
  assert.equal(answered, false, 'the home\'s wait answered before the count was made')
  release()
  const t = db.prepare('SELECT table_id FROM sheets WHERE id = ?').pluck().get(s) as string
  assert.deepEqual((await home).find(x => x.id === t), { id: t, row_count: 8, row_count_updating: false })
  assert.deepEqual(await sheetOf(), { id: s, name: 'Sheet1', position: 0, row_count: 8 })
})

await ok('migration 063 counts every sheet\'s rows', () => {
  const s = newSheet(3)
  db.prepare('UPDATE sheets SET counted_rows = 0').run()
  const sql = fs.readFileSync('server/src/db/migrations/063_sheet_counted_rows.sql', 'utf8')
  db.exec(sql.slice(sql.indexOf('UPDATE sheets')))
  assert.equal(kept(s), 3)
  const wrong = db.prepare(`SELECT COUNT(*) FROM sheets s WHERE counted_rows !=
    (SELECT COUNT(*) FROM rows r WHERE r.sheet_id = s.id AND r.user_id = s.user_id)`).pluck().get() as number
  assert.equal(wrong, 0)
})

await closeWalCheckpointer()
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
process.exit(0)
