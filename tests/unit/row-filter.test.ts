// Over 200 lines: one table-driven equivalence suite (SQL vs the JS reading) plus the grammar's error cases.
// Row filters (lib/row-filter): the SQL every reader runs passes exactly the
// rows the plain JS reading does (tests/unit/row-filter-reference.ts, built
// from the operator and cell-status code "Only run if" uses), over cells full
// of edge cases; plus the grammar's shape and sheet checks, the grid's saved
// filters (older saves included), and include_status's cell views. Pure: an
// in-memory SQLite with the filter functions, no app database.
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import sqlMod from '../../server/src/lib/row-filter/sql'
import fnMod from '../../server/src/lib/row-filter/sql-functions'
import whereMod from '../../server/src/lib/row-filter/where'
import gridMod from '../../server/src/lib/row-filter/grid'
import statusMod from '../../server/src/lib/row-filter/cell-status'
import rowsMod from '../../server/src/lib/row-filter/status-rows'
import ruleMod from '../../server/src/lib/run-condition'
import { referencePasses } from './row-filter-reference'
import type { FilterCondition, WhereItem } from '../../server/src/lib/row-filter/where'
const { compileWhere } = sqlMod as typeof import('../../server/src/lib/row-filter/sql')
const { registerRowFilterFunctions } = fnMod as typeof import('../../server/src/lib/row-filter/sql-functions')
const { parseWhere, checkWhere } = whereMod as typeof import('../../server/src/lib/row-filter/where')
const { parseColumnFilters, parseEmptyFilter, gridWhere } =
  gridMod as typeof import('../../server/src/lib/row-filter/grid')
const { cellStatus, cellStatusView } = statusMod as typeof import('../../server/src/lib/row-filter/cell-status')
const { rowWithStatus } = rowsMod as typeof import('../../server/src/lib/row-filter/status-rows')
const { checkRule, rulePasses } = ruleMod as typeof import('../../server/src/lib/run-condition')

let failures = 0
function check(label: string, fn: () => void) {
  try {
    fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const db = new Database(':memory:')
registerRowFilterFunctions(db)
db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, data TEXT NOT NULL)')

const MARKS = ['', ' ', '\t', '\u00a0', '❌ Error: rate limited', ' ❌ Failed ', '❌', '⏳ Processing...',
  '➕ Adding 3 rows…', '⏭️ Condition not met', ' ⏭️ Condition not met\n', '⏭️ Condition not met!',
  '⏭️ Not found',
  '⏭ Not found', '✅ Found', '✅', 'x❌', 'Real answer', 5, null, undefined]
const TEXTS = ['', '  ', '\u2003', 'MÜNCHEN', 'münchen', ' München ', 'Acme, Inc.', '1,000', '1000', '-5', '1e3', 'N/A',
  '0x10', "O'Brien", '50%', 'a_b', 'İstanbul', 'ß', 12, 1.5, null, undefined, '❌ Error', '⏭️ Not found']

// Dates as people, imports and APIs write them, and near misses (an impossible
// day, a two-digit year, a bare number, a time that can't be).
const DATES = ['2024-01-31', '2024-1-31', '2024/01/31', '2024.01.31', '2024-01-31T10:30:00Z',
  '2024-01-31T23:59:59.123-05:00', '2024-01-31 10:30', ' 2024-01-31 ', '2024-02-29', '2023-02-29', '2024-13-01',
  '2024-00-10', '1/31/2024', '31/1/2024', '01/02/2024', '1-31-2024', '31.01.2024', '2.1.2024', '1.13.2024',
  '13/13/2024', '1/31/24', 'Jan 31, 2024', 'January 31st 2024', 'JAN 31 2024', 'jan. 31, 2024', '31 Jan 2024',
  '31-Jan-2024', 'Wed, 31 Jan 2024 10:00:00 GMT', 'Wednesday, January 31, 2024', 'Feb 30, 2024', 'Sept 1, 2024',
  'Smarch 1, 2024', '2024-01-30', '2024-02-01', '2023-12-31', '1999-12-31', '20240131', '1706659200', '2024',
  'Jan 2024', 'yesterday', '2024-01-31 25:00', '1/31/2024 10:30 PM', '1/31/2024 13:30 PM', '0001-01-01',
  '9999-12-31', 'mon 1 jan 2024', '2024-01-31T10:30:00+0530', '', '  ', '❌ Error', '⏭️ Not found', 12, null,
  undefined]

// Rows: every text in A and N; every pair of marks as (output O, its status S);
// D a "(Data)" column on O's run; every date text in T (with a text in A).
const rows: Array<Record<string, unknown>> = []
const put = (o: Record<string, unknown>) => {
  const data = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
  rows.push(data)
  db.prepare('INSERT INTO rows (data) VALUES (?)').run(JSON.stringify(data))
}
for (const a of TEXTS) for (const n of [TEXTS[7], TEXTS[9], a]) put({ A: a, N: n })
for (const o of MARKS) for (const s of MARKS) put({ O: o, S: s, D: o === 'Real answer' ? '📊 3 sources' : '' })
DATES.forEach((t, i) => put({ T: t, A: TEXTS[i % TEXTS.length] }))
const runColumns = new Map([['O', 'S'], ['S', 'S'], ['D', 'S']])

const sqlMatches = (where: WhereItem[], runs: ReadonlyMap<string, string>): number[] => {
  const f = compileWhere(where, runs)
  assert.equal((f.sql.match(/\?/g) ?? []).length, f.params.length, 'one param per placeholder')
  return (db.prepare(`SELECT id FROM rows WHERE ${f.sql} ORDER BY id`).pluck().all(...f.params) as number[])
}
const jsMatches = (where: WhereItem[], runs: ReadonlyMap<string, string>): number[] =>
  rows.flatMap((data, i) => (referencePasses(where, data, runs) ? [i + 1] : []))

const VALUES = ['münchen', 'MÜNCHEN', ' münchen ', 'acme', ',', '1,000', '1000', "o'brien", '%', '_', 'istanbul',
  'ss', '', '12', '1.5', '❌', 'mün', 'chen', 'inc.', '000', 'i̇stanbul', '€', '😀x']
const conditions: FilterCondition[] = []
for (const value of VALUES) {
  for (const operator of ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with'] as const) {
    conditions.push({ column: 'A', operator, value })
  }
}
for (const operator of ['empty', 'not_empty'] as const) {
  conditions.push({ column: 'A', operator }, { column: 'O', operator })
}
for (const operator of ['any_of', 'not_any_of'] as const) {
  conditions.push({ column: 'A', operator, values: ['münchen', 'acme, inc.', ''] },
    { column: 'A', operator, values: ['ß'] })
}
for (const value of ['999', '1000', '1,000', '-5', '0', '16', '1e3']) {
  for (const operator of ['gt', 'gte', 'lt', 'lte'] as const) conditions.push({ column: 'N', operator, value })
}
for (const operator of ['has_error', 'has_result', 'not_run', 'condition_not_met', 'running'] as const) {
  conditions.push({ column: 'O', operator }, { column: 'S', operator }, { column: 'D', operator }, { operator })
}
for (const value of ['2024-01-31', 'Jan 31, 2024', '31.1.2024', '2024-02-29', '1999-12-31', '0001-01-01']) {
  for (const operator of ['date_eq', 'date_neq', 'date_gt', 'date_gte', 'date_lt', 'date_lte'] as const) {
    conditions.push({ column: 'T', operator, value })
  }
}
conditions.push({ column: 'T', operator: 'empty' }, { column: 'T', operator: 'not_empty' })

check(`SQL == JS on ${conditions.length} conditions x ${rows.length} rows`, () => {
  for (const c of conditions) {
    assert.deepEqual(sqlMatches([c], runColumns), jsMatches([c], runColumns), JSON.stringify(c))
  }
})
check('SQL == JS on AND lists and OR groups', () => {
  for (let i = 0; i + 2 < conditions.length; i += 3) {
    const where: WhereItem[] = [{ or: [conditions[i], conditions[i + 1]] }, conditions[i + 2]]
    assert.deepEqual(sqlMatches(where, runColumns), jsMatches(where, runColumns), JSON.stringify(where))
  }
})
// Seeded, so a failure reproduces: trees of AND and OR groups up to 4 deep,
// about one condition in five turned off (groups left with nothing on too).
let seed = 20261018
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]
function tree(depth: number): WhereItem {
  if (depth >= 4 || random() < 0.45) {
    const c = pick(conditions)
    return random() < 0.2 ? { ...c, enabled: false } : c
  }
  const items = Array.from({ length: 1 + Math.floor(random() * 3) }, () => tree(depth + 1))
  return random() < 0.6 ? { or: items } : { and: items }
}
check('SQL == JS on 400 nested AND/OR trees with conditions turned off', () => {
  let split = 0
  for (let i = 0; i < 400; i++) {
    const where = Array.from({ length: 1 + Math.floor(random() * 3) }, () => tree(0))
    const got = sqlMatches(where, runColumns)
    assert.deepEqual(got, jsMatches(where, runColumns), JSON.stringify(where))
    if (got.length > 0 && got.length < rows.length) split++
  }
  // Many trees must split the rows (181 of 400 do), or the comparison proves little.
  assert.ok(split > 150, `only ${split} of 400 trees split the rows`)
})
check('every condition off: every row; an OR group of off conditions narrows nothing', () => {
  const all = rows.map((_, i) => i + 1)
  const off = { column: 'A', operator: 'eq', value: 'münchen', enabled: false } as const
  assert.deepEqual(sqlMatches([off], runColumns), all)
  assert.deepEqual(sqlMatches([{ or: [off, { and: [off] }] }], runColumns), all)
  assert.deepEqual(compileWhere([{ or: [off] }], runColumns), { sql: '1', params: [] })
  const on = { column: 'A', operator: 'eq', value: 'münchen' } as const
  assert.deepEqual(sqlMatches([{ or: [off, on] }], runColumns), sqlMatches([on], runColumns))
})
check('a run-state operator on a column no run fills reads its own cell; no run columns pass nothing', () => {
  for (const operator of ['has_error', 'not_run'] as const) {
    const own: WhereItem[] = [{ column: 'O', operator }]
    assert.deepEqual(sqlMatches(own, new Map()), jsMatches(own, new Map()))
    assert.deepEqual(sqlMatches([{ operator }], new Map()), [])
  }
})

// What the operators mean, spelled out.
const one = (cell: unknown, c: Omit<FilterCondition, 'column'> & { column?: string }) => {
  db.exec('DELETE FROM rows WHERE id > 100000')
  db.prepare('INSERT INTO rows (id, data) VALUES (100001, ?)').run(JSON.stringify({ A: cell }))
  const f = compileWhere([{ column: 'A', ...c } as FilterCondition], new Map())
  return !!db.prepare(`SELECT 1 FROM rows WHERE id = 100001 AND ${f.sql}`).get(...f.params)
}
check('text compares ignore case (beyond ASCII) and outer spaces', () => {
  assert.equal(one('MÜNCHEN', { operator: 'eq', value: ' münchen ' }), true)
  assert.equal(one('Acme, Inc.', { operator: 'contains', value: 'ACME' }), true)
  assert.equal(one('50%', { operator: 'contains', value: '%' }), true)
  assert.equal(one('a', { operator: 'contains', value: '%' }), false)
  assert.equal(one('\u2003', { operator: 'empty' }), true)
  assert.equal(one(undefined, { operator: 'neq', value: 'x' }), true)
  assert.equal(one(undefined, { operator: 'not_any_of', values: ['x'] }), true)
  assert.equal(one('', { operator: 'any_of', values: ['', 'x'] }), true)
})
check('starts_with / ends_with: folded, outer spaces off, characters beyond ASCII', () => {
  assert.equal(one(' MÜNCHEN GmbH ', { operator: 'starts_with', value: 'münchen' }), true)
  assert.equal(one(' MÜNCHEN GmbH ', { operator: 'ends_with', value: 'GMBH' }), true)
  assert.equal(one('MÜNCHEN GmbH', { operator: 'ends_with', value: 'münchen' }), false)
  assert.equal(one('ab', { operator: 'starts_with', value: 'abc' }), false)
  assert.equal(one('bc', { operator: 'ends_with', value: 'abc' }), false)
  assert.equal(one('😀x', { operator: 'starts_with', value: '😀' }), true)
  assert.equal(one('a😀', { operator: 'ends_with', value: '😀' }), true)
  assert.equal(one('50%', { operator: 'ends_with', value: '%' }), true)
  assert.equal(one(undefined, { operator: 'starts_with', value: 'a' }), false)
  assert.match(checkWhere([{ column: 'A', operator: 'ends_with', value: ' ' }], { columns: ['A'], runColumns })!,
    /non-empty value/)
})
check('numbers: commas allowed; text that is not a number never passes', () => {
  assert.equal(one('1,000', { operator: 'gt', value: '999' }), true)
  assert.equal(one('N/A', { operator: 'lt', value: '1000000' }), false)
  assert.equal(one('', { operator: 'gt', value: '-1' }), false)
  assert.equal(one(12, { operator: 'gte', value: '12' }), true)
  assert.equal(one('-2,500.5', { operator: 'lt', value: '0' }), true)
  // A comma that isn't a thousands separator (a decimal comma, a list) is no number.
  assert.equal(one('1,5', { operator: 'gt', value: '10' }), false)
  assert.equal(one('1,5', { operator: 'lt', value: '10' }), false)
  assert.equal(one('2024,2025', { operator: 'gt', value: '0' }), false)
})
check('cell status: own words first, a blank output reads its status cell', () => {
  assert.equal(cellStatus('❌ Error: x'), 'error')
  assert.equal(cellStatus('', '❌ Rate limited'), 'error')
  assert.equal(cellStatus('', '✅ Found'), 'no_result')
  assert.equal(cellStatus('', '⏭️ Condition not met'), 'condition_not_met')
  assert.equal(cellStatus('', '➕ Adding 2 rows…'), 'running')
  assert.equal(cellStatus('', ''), 'not_run')
  assert.equal(cellStatus('⏭️ Not found'), 'no_result')
  assert.equal(cellStatus('✅ Found'), 'done')
  assert.equal(cellStatus('kept value', '⏳ Processing...'), 'done')
  assert.deepEqual(cellStatusView('❌ Error: Rate limited'), { status: 'error', value: null, error: 'Rate limited' })
  assert.deepEqual(cellStatusView('❌ Failed'), { status: 'error', value: null, error: 'Failed' })
  assert.deepEqual(cellStatusView('', '❌'), { status: 'error', value: null, error: 'Error' })
  assert.deepEqual(cellStatusView('⏭️ Budget ran out'),
    { status: 'no_result', value: null, error: null, reason: 'Budget ran out' })
  assert.deepEqual(cellStatusView('', '✅ Found'), { status: 'no_result', value: null, error: null })
  assert.deepEqual(cellStatusView(' ann@x.com '), { status: 'done', value: ' ann@x.com ', error: null })
})
check('include_status rows: run columns as views, every run column listed, plain columns as they are', () => {
  const runs = new Map([['Email', 'Status'], ['Status', 'Status']])
  assert.deepEqual(rowWithStatus({ Name: 'Ann', Status: '❌ Timed out' }, runs), {
    Name: 'Ann', Status: { status: 'error', value: null, error: 'Timed out' },
    Email: { status: 'error', value: null, error: 'Timed out' },
  })
  assert.deepEqual(rowWithStatus({ Name: 'Ann' }, runs, ['Email', 'Name', 'Gone']), {
    Email: { status: 'not_run', value: null, error: null }, Name: 'Ann', Gone: '',
  })
})

// The grammar's checks: messages an agent can act on.
const shapeError = (raw: unknown) => { const r = parseWhere(raw); return 'error' in r ? r.error : null }
check('where shape: conditions and groups', () => {
  assert.equal(shapeError([{ column: 'A', operator: 'eq', value: 'x' }, { or: [{ operator: 'has_error' }] }]), null)
  assert.match(shapeError([{ or: [{ or: [] }] }])!, /at least one/)
  assert.match(shapeError([{ or: [] }])!, /at least one/)
  assert.match(shapeError([{ or: [{ operator: 'running' }], column: 'A' }])!, /only "or"/)
  assert.match(shapeError([{ column: 'A', operator: 'like', value: 'x' }])!, /Unknown where operator "like"/)
  assert.match(shapeError([{ column: 'A', operator: 'gt', value: 5 }])!, /send "1000", not 1000/)
  assert.match(shapeError([{ column: 'A', operator: 'any_of', values: ['a', 1] }])!, /list of strings/)
  assert.match(shapeError([{ column: 'A', operator: 'eq', value: 'x', op: 'eq' }])!, /Unknown key "op"/)
  assert.match(shapeError([])!, /non-empty/)
  assert.match(shapeError(Array.from({ length: 51 }, () => ({ operator: 'running' })))!, /at most 50/)
})
const sheetError = (where: unknown[]) => checkWhere(where as WhereItem[], { columns: ['A', 'O', 'S'], runColumns })
check('where against the sheet', () => {
  assert.equal(sheetError([{ operator: 'has_error' }, { column: 'O', operator: 'not_run' }]), null)
  assert.match(sheetError([{ column: 'A', operator: 'has_error' }])!, /"A" isn't an AI, HTTP API or enrichment column/)
  assert.match(sheetError([{ column: 'Z', operator: 'eq', value: '' }])!, /Unknown column\(s\): Z/)
  assert.match(sheetError([{ operator: 'eq', value: 'x' }])!, /eq needs a column/)
  assert.match(sheetError([{ column: 'A', operator: 'any_of', value: 'x' }])!, /takes values \(a list\)/)
  assert.match(sheetError([{ column: 'A', operator: 'any_of' }])!, /needs values/)
  assert.match(sheetError([{ column: 'A', operator: 'eq', values: ['x'] }])!, /only for any_of/)
  assert.match(sheetError([{ column: 'A', operator: 'contains', value: '  ' }])!, /non-empty value/)
  assert.match(sheetError([{ column: 'A', operator: 'gt', value: 'ten' }])!, /numeric value/)
  assert.match(sheetError([{ column: 'A', operator: 'empty', value: '' }])!, /does not accept a value/)
  assert.match(sheetError([{ operator: 'running', value: 'x' }])!, /takes no value/)
  assert.match(sheetError([{ or: Array.from({ length: 51 }, () => ({ operator: 'running' })) }])!, /at most 50/)
  assert.match(sheetError([{ or: [{ column: 'A', operator: 'eq', value: 'x' }, { column: 'Q', operator: 'empty' }] }])!,
    /Q/)
})

check('grid filters: older saves still read, bad entries dropped, new operators kept', () => {
  const saved = JSON.stringify({
    A: { type: 'contains', value: 'acme' }, B: { type: 'contains', value: '  ' }, C: { type: 'nope', value: 'x' },
    D: ['contains'], E: { type: 'any_of', values: ['x', 'y'] }, F: { type: 'has_error' },
    G: { type: 'gt', value: 'x' },
  })
  assert.deepEqual(parseColumnFilters(saved), {
    A: { type: 'contains', value: 'acme' }, E: { type: 'any_of', values: ['x', 'y'] }, F: { type: 'has_error' },
  })
  assert.deepEqual(parseColumnFilters('[1]'), {})
  assert.deepEqual(parseColumnFilters('{bad json'), {})
  assert.deepEqual(parseEmptyFilter('{"A":"empty","B":"maybe"}'), { A: 'empty' })
  const where = gridWhere({ A: 'not_empty' }, { O: { type: 'has_error' } })
  assert.deepEqual(where.map(c => [c.column, c.operator]), [['A', 'not_empty'], ['O', 'has_error']])
  assert.deepEqual(sqlMatches(where, runColumns), jsMatches(where, runColumns))
})

check('"Only run if" rules read cells with the same operators (markers still read as empty there)', () => {
  const rule = (text: string, data: Record<string, string>) =>
    rulePasses(checkRule(text, Object.keys(data)).tree, data)
  assert.equal(rule('{{City}} is "münchen"', { City: 'MÜNCHEN' }), true)
  assert.equal(rule('{{N}} > 999', { N: '1,000' }), true)
  assert.equal(rule('{{N}} is 50', { N: '50.0' }), true)
  assert.equal(rule('{{N}} is "50"', { N: '50.0' }), false)
  assert.equal(rule('{{Out}} is empty', { Out: '❌ Error: x' }), true)
  assert.equal(rule('{{Out}} does not contain "x"', { Out: 'X-ray' }), false)
})

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll row-filter assertions passed.')
