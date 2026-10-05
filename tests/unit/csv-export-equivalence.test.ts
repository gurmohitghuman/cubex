// CSV export takes its column list from getSheetColumns (the column registry
// the grid shows) and streams rows, instead of SELECT * of every row. It must
// stay byte-identical to a plain reference builder over that same list (the
// stored column_order, or the rows' first-seen keys when a sheet has none):
// pinned here on adversarial sheets.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import sqlMod from '../../server/src/lib/sql-helpers'
import exportMod from '../../server/src/lib/csv-export'
import safetyMod from '../../server/src/lib/csv-safety'
import busyModule from '../../server/src/lib/sheet-busy'
import selMod from '../../server/src/services/row-selection'
import { v4 as uuid } from 'uuid'
import type { RowCondition } from '../../server/src/services/row-selection'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { listColumnsInInsertionOrder, parseRowData } =
  sqlMod as typeof import('../../server/src/lib/sql-helpers')
const { buildSheetCsv, streamSheetCsv } = exportMod as typeof import('../../server/src/lib/csv-export')
const { escapeCsvCell } = safetyMod as typeof import('../../server/src/lib/csv-safety')
const busyMod = busyModule as typeof import('../../server/src/lib/sheet-busy')
const { rowPasses, validateRowConditions } = selMod as typeof import('../../server/src/services/row-selection')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

type Opts = { columns?: string[]; where?: RowCondition[] }

// A plain export builder: registry columns (stored names, deduped, or the rows'
// first-seen keys when there is no usable list), then every row via SELECT *.
function referenceCsv(sheetId: string, userId: string, opts: Opts = {}) {
  const sheet = db.prepare('SELECT name, column_order FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { name: string; column_order: string | null }
  let allColumns: string[]
  try {
    const stored = JSON.parse(sheet.column_order ?? 'null')
    if (!Array.isArray(stored)) throw new Error('none')
    allColumns = [...new Set(stored.filter((c): c is string => typeof c === 'string'))]
  } catch { allColumns = listColumnsInInsertionOrder(sheetId, userId) }
  let columns = allColumns
  if (opts.columns?.length) {
    if (opts.columns.some(c => !allColumns.includes(c))) return { fail: 'invalid' }
    columns = opts.columns
  }
  if (opts.where?.length && validateRowConditions(allColumns, opts.where)) return { fail: 'invalid' }
  const dbRows = db.prepare('SELECT * FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index ASC')
    .all(sheetId, userId) as Array<{ data: string }>
  const matched = opts.where?.length ? dbRows.filter(r => rowPasses(parseRowData(r.data), opts.where!)) : dbRows
  if (dbRows.length === 0) return { fail: 'empty' }
  const lines = [columns.map(escapeCsvCell).join(','),
    ...matched.map(r => { const d = parseRowData(r.data); return columns.map(c => escapeCsvCell(d[c] ?? '')).join(',') })]
  return {
    ok: true, sheetName: sheet.name, csv: lines.join('\r\n'), columns,
    rowCount: matched.length, matchingRows: matched.length, truncated: false,
  }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
// rows: raw JSON texts (so duplicate keys / escapes reach SQLite verbatim).
function sheet(columnOrder: string | null, rows: string[]): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, columnOrder)
  rows.forEach((data, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, i, data))
  return sid
}
const order = (cols: unknown[]) => JSON.stringify(cols)

const injection = sheet(order(['b', 'ghost', 'a']), [
  '{"a":"=SUM(1)","b":"x, \\"quoted\\"\\nline"}', '{"a":"+1","b":"plain","leak":"@x"}', '{"b":"-2"}', '{"a":" ","b":"\\tTab"}'])
const cases: Array<[string, string, Opts]> = [
  ['clean', sheet(order(['a', 'b']), ['{"a":"1","b":"2"}', '{"a":"3","b":"4"}']), {}],
  ['empty columns kept, unlisted keys left out', sheet(order(['ghost', 'a', 'ghost2']), ['{"b":"1","a":"2"}', '{"c":"3"}']), {}],
  // No list: the rows' keys in first-seen order (a, y, x: row 0's keys tie on row, then json_each order).
  ['no list, keys first seen in different rows', sheet(null, ['{"a":"1","x":"2","y":"3"}', '{"y":"4"}']), {}],
  ['column_order NULL', sheet(null, ['{"b":"1","a":"2"}', '{"c":"3","a":"4"}']), {}],
  ['column_order invalid JSON', sheet('[not json', ['{"a":"1"}']), {}],
  ['column_order object JSON', sheet('{"a":1}', ['{"a":"1","b":"2"}']), {}],
  ['column_order with dups + non-strings', sheet(order([1, 'a', 'a', null, 'b']), ['{"a":"1","b":"2","1":"3"}']), {}],
  ['zero rows → empty', sheet(order(['a']), []), {}],
  ['odd keys', sheet(order(['sp ace', '2024', '', 'a"b', 'c\\d']), [
    '{"sp ace":"1","2024":"2","":"3","a\\"b":"4","c\\\\d":"5","obj":{"x":"1"}}']), {}],
  ['injection + quoting', injection, {}],
  ['column subset, caller order', injection, { columns: ['a', 'leak'] }],
  ['unknown column', injection, { columns: ['a', 'ghost'] }],
  ['where matches some', injection, { where: [{ column: 'b', operator: 'contains', value: 'p' }] }],
  ['where matches none', injection, { where: [{ column: 'b', operator: 'eq', value: 'nope' }] }],
  ['where on an unknown column', injection, { where: [{ column: 'zz', operator: 'eq', value: '1' }] }],
]
for (const [label, sid, opts] of cases) {
  await (async () => {
    try {
      const want = referenceCsv(sid, uid, opts)
      const got = await buildSheetCsv(sid, uid, opts)
      assert.deepEqual('fail' in got ? { fail: got.fail } : got, want)
      assert.deepEqual(await buildSheetCsv(sid, uid, opts), got) // a second export agrees
      console.log('ok  ', `${label}: export == reference`)
    } catch (e) { failures++; console.log('FAIL', `${label}: export == reference`, '\n ', (e as Error).message) }
  })()
}

// The download the UI and /api/v1 routes stream, a page of rows at a time, is
// byte-identical to buildSheetCsv: across many pages, and with a client that
// pushes back on every write.
function fakeResponse(slow: boolean) {
  const headers: Record<string, string> = {}
  const waiting: Array<() => void> = []
  let body = '', ended = false
  const res = {
    destroyed: false,
    setHeader: (k: string, v: string) => { headers[k] = v },
    write: (chunk: string) => {
      body += chunk
      if (!slow) return true
      setImmediate(() => waiting.splice(0).forEach(f => f()))
      return false
    },
    on: (event: string, f: () => void) => { if (event === 'drain') waiting.push(f); return res },
    off: (_event: string, f: () => void) => { const i = waiting.indexOf(f); if (i >= 0) waiting.splice(i, 1); return res },
    end: () => { ended = true },
  }
  return { res: res as unknown as import('express').Response, read: () => ({ headers, body, ended }) }
}
const big = sheet(order(['a', 'b']), Array.from({ length: 12_345 }, (_, i) => JSON.stringify({ a: `=r${i}`, b: `x,"${i}"` })))
for (const [label, sid] of [['injection + quoting', injection], ['12,345 rows', big]] as const) {
  for (const slow of [false, true]) {
    await (async () => {
      const label2 = `stream (${slow ? 'slow client' : 'fast client'}) == build: ${label}`
      try {
        const { res, read } = fakeResponse(slow)
        assert.equal(await streamSheetCsv(sid, uid, res), 'ok')
        const built = await buildSheetCsv(sid, uid)
        assert.ok('ok' in built)
        const got = read()
        assert.equal(got.body, built.csv)
        assert.ok(got.ended)
        assert.equal(got.headers['Content-Type'], 'text/csv; charset=utf-8')
        console.log('ok  ', label2)
      } catch (e) { failures++; console.log('FAIL', label2, '\n ', (e as Error).message) }
    })()
  }
}

// With a size cap (the MCP tool's), whole rows go in until the next would pass
// it, then reading stops: the total comes from the index without a filter,
// and is unknown (null) with one.
await (async () => {
  const label = 'capped: whole rows up to the cap, then it stops reading'
  try {
    const full = await buildSheetCsv(big, uid)
    const capped = await buildSheetCsv(big, uid, { maxChars: 40_000 })
    assert.ok('ok' in full && 'ok' in capped)
    assert.equal(capped.truncated, true)
    assert.equal(capped.matchingRows, 12_345)
    assert.ok(capped.csv.length <= 40_000)
    assert.ok(full.csv.startsWith(capped.csv + '\r\n'), 'a prefix ending on a whole row')
    assert.equal(capped.csv.split('\r\n').length - 1, capped.rowCount)
    const filtered = await buildSheetCsv(big, uid, { maxChars: 40_000, where: [{ column: 'a', operator: 'contains', value: 'r' }] })
    assert.ok('ok' in filtered && filtered.truncated && filtered.matchingRows === null)
    const roomy = await buildSheetCsv(injection, uid, { maxChars: 40_000 })
    assert.ok('ok' in roomy && roomy.truncated === false && roomy.rowCount === roomy.matchingRows)
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
})()

// A client that leaves mid-download ends the export, and the sheet is free for
// heavy operations again (the read hold is released).
await (async () => {
  const label = 'stream: a client that disconnects ends it and frees the sheet'
  try {
    const { res } = fakeResponse(false)
    let pages = 0
    const write = res.write.bind(res)
    ;(res as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      if (++pages === 2) (res as unknown as { destroyed: boolean }).destroyed = true
      return write(c)
    }
    assert.equal(await streamSheetCsv(big, uid, res), 'ok')
    assert.equal(pages, 2)
    const after = await busyMod.withSheetBusy(big, 'test', async () => 'free')
    assert.equal(after, 'free')
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
})()

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll csv-export-equivalence assertions passed.')
