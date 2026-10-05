// The column registry (lib/sheet-columns.ts): a sheet's columns are exactly
// sheets.column_order, so reading them never scans rows. Pins: the stored list
// comes back as-is (an empty column is still a column), minus non-names and
// repeats; a sheet without a usable list is seeded from its rows in first-seen
// order and saved unless persist=false; appendColumnsToOrder seeds, appends and
// skips duplicates; autosave writes land in any listed column (even one no row
// holds yet) and only in rows that exist; adding a column touches no row; and
// the background repair appends keys the rows hold but the list misses, across
// several slices, without ever removing a listed column.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import sqlMod from '../../server/src/lib/sql-helpers'
import writeMod from '../../server/src/routes/sheets-data-write'
import validateMod from '../../server/src/routes/sheets-data-validate'
import addMod from '../../server/src/services/column-add'
import repairMod from '../../server/src/lib/column-repair'
import constMod from '../../server/src/lib/constants'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { getSheetColumns, appendColumnsToOrder } = sqlMod as typeof import('../../server/src/lib/sql-helpers')
const { applyDataWrite } = writeMod as typeof import('../../server/src/routes/sheets-data-write')
const { parseDataBody } = validateMod as typeof import('../../server/src/routes/sheets-data-validate')
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
const { scheduleColumnRepair } = repairMod as typeof import('../../server/src/lib/column-repair')
const { COLUMN_REPAIR_SLICE_ROWS } = constMod as typeof import('../../server/src/lib/constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {} // the repair warns by design; keep the output readable

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

// rows: raw JSON texts (so duplicate keys / escapes reach SQLite verbatim).
function sheet(columnOrder: string | null, rows: string[]): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, columnOrder)
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => rows.forEach((data, i) => ins.run(uuid(), sid, uid, i, data)))()
  return sid
}
const order = (cols: unknown[]) => JSON.stringify(cols)
const stored = (sid: string) =>
  (db.prepare('SELECT column_order FROM sheets WHERE id = ?').get(sid) as { column_order: string | null }).column_order
const rowData = (sid: string, i: number) => JSON.parse((db.prepare(
  'SELECT data FROM rows WHERE sheet_id = ? AND row_index = ?').get(sid, i) as { data: string }).data)

async function main(): Promise<void> {
  // ── Reading the list ──────────────────────────────────────────────────────
  const listed: Array<[string, string | null, string[], string[]]> = [
    ['stored list as-is, empty columns kept', order(['a', 'empty', 'b']), ['{"a":"1","b":"2"}'], ['a', 'empty', 'b']],
    ['zero rows keeps its columns', order(['a', 'b']), [], ['a', 'b']],
    ['non-names and repeats dropped', order([1, 'a', 'a', null, 'b']), ['{"a":"1","b":"2","1":"3"}'], ['a', 'b']],
    ['unlisted keys are not columns', order(['a']), ['{"a":"1","z":"2"}'], ['a']],
    ['no list: seeded in first-seen order', null, ['{"b":"1","a":"2"}', '{"c":"3","a":"4"}'], ['b', 'a', 'c']],
    ['invalid JSON: seeded', '[not json', ['{"a":"1"}'], ['a']],
    ['object JSON: seeded', '{"a":1}', ['{"a":"1","b":"2"}'], ['a', 'b']],
    ['"null" JSON: seeded', 'null', ['{"a":"1"}'], ['a']],
  ]
  for (const [label, columnOrder, rows, want] of listed) {
    await ok(`getSheetColumns: ${label}`, () => {
      const sid = sheet(columnOrder, rows)
      assert.deepEqual(getSheetColumns(sid, uid, false), want)
      assert.equal(stored(sid), columnOrder, 'persist=false never writes')
      assert.deepEqual(getSheetColumns(sid, uid), want)
      const seeded = columnOrder === null || !Array.isArray((() => { try { return JSON.parse(columnOrder) } catch { return null } })())
      assert.equal(stored(sid), seeded ? JSON.stringify(want) : columnOrder, 'a seeded list is saved, a stored one left alone')
    })
  }
  await ok('getSheetColumns: unknown sheet → []', () => assert.deepEqual(getSheetColumns(uuid(), uid), []))

  await ok('appendColumnsToOrder: seeds a missing list, appends, skips duplicates', () => {
    const sid = sheet(null, ['{"b":"1","a":"2"}'])
    appendColumnsToOrder(sid, uid, ['a', 'new', 'new', 'z'])
    assert.equal(stored(sid), order(['b', 'a', 'new', 'z']))
  })

  // ── Writing ───────────────────────────────────────────────────────────────
  await ok('applyDataWrite update mode: listed columns only, existing rows only', () => {
    const sid = sheet(order(['a', 'fresh', 'b']), ['{"a":"1","b":"2"}', '{"a":"3","unlisted":"x"}', '{}', '{"a":"5"}'])
    db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index = 2').run(sid)
    const res = applyDataWrite({
      id: sid, userId: uid, mode: 'update', lockedColumns: new Set(),
      updates: [
        { rowIndex: 0, columnName: 'a', value: 'A0' }, { rowIndex: 0, columnName: 'fresh', value: 'F0' },
        { rowIndex: 1, columnName: 'unlisted', value: 'U1' }, { rowIndex: 2, columnName: 'a', value: 'gone' },
        { rowIndex: 3, columnName: 'b', value: 'B3' },
      ],
    })
    assert.deepEqual(res.skippedCells, [{ rowIndex: 1, columnName: 'unlisted' }, { rowIndex: 2, columnName: 'a' }])
    assert.deepEqual(rowData(sid, 0), { a: 'A0', b: '2', fresh: 'F0' })
    assert.deepEqual(rowData(sid, 1), { a: '3', unlisted: 'x' })
    assert.deepEqual(rowData(sid, 3), { a: '5', b: 'B3' })
  })

  await ok('applyDataWrite: a column named before a sanitizing rule still takes edits', () => {
    // "Com" + zero-width space + "pany": sanitizing the key strips the hidden
    // character, but the registry holds the old name, so that exact match wins.
    const legacy = 'Com\u200Bpany'
    const sid = sheet(order([legacy]), [JSON.stringify({ [legacy]: 'old' })])
    const parsed = parseDataBody({ mode: 'update', updates: [{ rowIndex: 0, columnName: legacy, value: 'new' }] })
    if ('error' in parsed) throw new Error(parsed.error)
    const res = applyDataWrite({ id: sid, userId: uid, mode: 'update', lockedColumns: new Set(), updates: parsed.updates })
    assert.deepEqual(res.skippedCells, [])
    assert.deepEqual(rowData(sid, 0), { [legacy]: 'new' })
    // A key that matches nothing is still sanitized (and, here, skipped).
    const stray = parseDataBody({ mode: 'update', updates: [{ rowIndex: 0, columnName: 'Ot\u200Bher', value: 'x' }] })
    if ('error' in stray) throw new Error(stray.error)
    assert.equal(stray.updates[0].columnName, 'Other')
  })

  await ok('addSheetColumn: lists the column without touching a row', () => {
    const sid = sheet(order(['a']), ['{"a":"1"}', '{"a":"2"}', '{}'])
    const before = db.prepare('SELECT data, updated_at FROM rows WHERE sheet_id = ? ORDER BY row_index').all(sid)
    assert.deepEqual(addSheetColumn(sid, uid, 'notes'), { ok: true, name: 'notes' })
    assert.deepEqual(getSheetColumns(sid, uid), ['a', 'notes'])
    assert.deepEqual(db.prepare('SELECT data, updated_at FROM rows WHERE sheet_id = ? ORDER BY row_index').all(sid), before)
  })

  await ok('addSheetColumn: an empty sheet gets row 0 to type into', () => {
    const sid = sheet(null, [])
    assert.deepEqual(addSheetColumn(sid, uid, 'first'), { ok: true, name: 'first' })
    assert.deepEqual(getSheetColumns(sid, uid), ['first'])
    assert.deepEqual(db.prepare('SELECT row_index, data FROM rows WHERE sheet_id = ?').all(sid), [{ row_index: 0, data: '{}' }])
  })

  // ── Background repair ─────────────────────────────────────────────────────
  await ok('scheduleColumnRepair: appends unlisted keys across slices, keeps empty columns', async () => {
    const n = COLUMN_REPAIR_SLICE_ROWS + 5
    const rows = Array.from({ length: n }, (_, i) =>
      i === 3 ? '{"a":"1","early":"e"}' : i === n - 1 ? '{"a":"1","late":"l"}' : '{"a":"1"}')
    const sid = sheet(order(['a', 'empty']), rows)
    const version = () => (db.prepare('SELECT data_version FROM sheets WHERE id = ?').get(sid) as { data_version: number }).data_version
    const v0 = version()
    scheduleColumnRepair(sid, uid)
    for (let i = 0; i < 200 && stored(sid) === order(['a', 'empty']); i++) await new Promise(r => setImmediate(r))
    assert.deepEqual(getSheetColumns(sid, uid), ['a', 'empty', 'early', 'late'])
    assert.equal(version(), v0 + 1, 'open tabs are told to re-read')
  })

  await ok('scheduleColumnRepair: a clean sheet is left alone', async () => {
    const sid = sheet(order(['a', 'b', 'empty']), ['{"a":"1","b":"2"}'])
    scheduleColumnRepair(sid, uid)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    assert.equal(stored(sid), order(['a', 'b', 'empty']))
  })
}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
  console.log('\nAll column-registry assertions passed.')
}, (err) => { console.error(err); process.exit(1) })
