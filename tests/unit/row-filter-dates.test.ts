// Date conditions, groups and conditions turned off (lib/row-filter), spelled
// out: which texts are which day (checked against Date.UTC for every day of
// eight centuries), what the date operators pass, the shape checks for groups
// and "enabled", how a view's filter splits and survives a column rename or
// delete, and "Only run if" rules' date words. Pure: no app database (the SQL
// equals the JS reading in row-filter.test.ts).
import assert from 'node:assert/strict'
import datesMod from '../../server/src/lib/row-filter/dates'
import opsMod from '../../server/src/lib/row-filter/ops'
import whereMod from '../../server/src/lib/row-filter/where'
import filtersMod from '../../server/src/lib/views/filters'
import refsMod from '../../server/src/lib/views/refs'
import ruleMod from '../../server/src/lib/run-condition'
import type { WhereItem } from '../../server/src/lib/row-filter/where'
const { asDate } = datesMod as typeof import('../../server/src/lib/row-filter/dates')
const { datePasses } = opsMod as typeof import('../../server/src/lib/row-filter/ops')
const { parseWhere, activeWhere, checkWhere, allOffError } =
  whereMod as typeof import('../../server/src/lib/row-filter/where')
const { splitWhere, parseRowFilter } = filtersMod as typeof import('../../server/src/lib/views/filters')
const { mapViewColumns, dropColumn, renameTo } = refsMod as typeof import('../../server/src/lib/views/refs')
const { checkRule, rulePasses, renameRuleColumn } = ruleMod as typeof import('../../server/src/lib/run-condition')

let failures = 0
function check(label: string, fn: () => void) {
  try {
    fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const DAY_MS = 86_400_000
const day = (y: number, m: number, d: number) => {
  const t = new Date(0)
  t.setUTCFullYear(y, m - 1, d)
  return Math.round(t.getTime() / DAY_MS)
}

check('every day from 1600 to 2399 is the day Date.UTC says, written four ways', () => {
  const pad = (n: number) => String(n).padStart(2, '0')
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  for (let n = day(1600, 1, 1); n <= day(2399, 12, 31); n++) {
    const t = new Date(n * DAY_MS)
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate()
    for (const text of [`${y}-${pad(m)}-${pad(d)}`, `${m}/${d}/${y}`, `${MONTHS[m - 1]} ${d}, ${y}`,
      `${d}.${m}.${y}`]) {
      if (asDate(text) !== n) throw new Error(`${text}: ${asDate(text)}, want ${n}`)
    }
  }
})

check('formats: year first, year last (month first unless over 12), dots day first, month names', () => {
  const jan31 = day(2024, 1, 31)
  for (const text of ['2024-01-31', '2024-1-31', '2024/01/31', '2024.01.31', ' 2024-01-31 ', '1/31/2024',
    '31/1/2024', '1-31-2024', '31.01.2024', 'Jan 31, 2024', 'January 31st 2024', 'JAN 31 2024', 'jan. 31, 2024',
    '31 Jan 2024', '31-Jan-2024', '31st January, 2024', 'Wed, 31 Jan 2024', 'Wednesday, January 31, 2024']) {
    assert.equal(asDate(text), jan31, text)
  }
  assert.equal(asDate('01/02/2024'), day(2024, 1, 2), 'ambiguous: month first')
  assert.equal(asDate('2.1.2024'), day(2024, 1, 2), 'dots: day first')
  assert.equal(asDate('Sept 1, 2024'), day(2024, 9, 1))
  assert.equal(asDate('0001-01-01'), day(1, 1, 1))
  assert.equal(asDate('9999-12-31'), day(9999, 12, 31))
})

check('a time after the date is read and left out: the day is the one written, whatever the zone', () => {
  const jan31 = day(2024, 1, 31)
  for (const text of ['2024-01-31T10:30:00Z', '2024-01-31T23:59:59.123-05:00', '2024-01-31T00:00:00+0530',
    '2024-01-31 10:30', '1/31/2024 10:30 PM', '1/31/2024, 12:00 a.m.', 'Jan 31, 2024, 9:05 pm',
    'Wed, 31 Jan 2024 10:00:00 GMT', '31.01.2024 18:00', '2024-01-31 10:30:00 UTC', '31 Jan 2024 10:00 GMT+0100']) {
    assert.equal(asDate(text), jan31, text)
  }
})

check('not dates: impossible days and times, short years, bare numbers, words, cells that are not text', () => {
  for (const v of ['2023-02-29', '2024-02-30', '2024-13-01', '2024-00-10', '2024-01-00', '13/13/2024', '1.13.2024',
    '1/31/24', '20240131', '1706659200', '2024', 'Jan 2024', 'Smarch 1, 2024', 'yesterday', '2024-01-31 25:00',
    '1/31/2024 13:30 PM', '2024-01-31 10:61', '2024-01-31T', '2024-01/31', 'mon 1 jan 2024 x', '', '   ',
    '❌ Error', '⏭️ Not found', '2024-01-31'.padEnd(80, '!'), 'constructor 31, 2024', '31 constructor 2024',
    'toString 1, 2024', 12, 45000, null, undefined, true, {}]) {
    assert.equal(asDate(v), null, JSON.stringify(v))
  }
  assert.equal(asDate('2024-02-29'), day(2024, 2, 29), 'a leap day')
  assert.equal(asDate('2000-02-29'), day(2000, 2, 29), 'a leap century')
  assert.equal(asDate('1900-02-29'), null, 'not a leap century')
})

check('date operators compare days; a cell with no date passes none of them, "is not" included', () => {
  const a = day(2024, 1, 31), b = day(2024, 2, 1)
  assert.deepEqual(['date_eq', 'date_neq', 'date_gt', 'date_gte', 'date_lt', 'date_lte'].map(op =>
    datePasses(op as 'date_eq', a, b)), [false, true, false, false, true, true])
  assert.deepEqual(['date_eq', 'date_gte', 'date_lte'].map(op => datePasses(op as 'date_eq', a, a)), [true, true, true])
  for (const op of ['date_eq', 'date_neq', 'date_gt', 'date_lt'] as const) {
    assert.equal(datePasses(op, null, a), false)
  }
})

const shapeError = (raw: unknown) => { const r = parseWhere(raw); return 'error' in r ? r.error : null }
const deep = (n: number): unknown => (n === 0 ? { column: 'A', operator: 'empty' } : { and: [deep(n - 1)] })
check('where shape: groups in groups up to five deep, "enabled" true or false', () => {
  assert.equal(shapeError([deep(5)]), null)
  assert.match(shapeError([deep(6)])!, /at most 5 deep/)
  assert.match(shapeError([{ and: [] }])!, /AND group is .* at least one/)
  assert.match(shapeError([{ and: [{ operator: 'running' }], or: [] }])!, /not both/)
  assert.match(shapeError([{ and: [{ operator: 'running' }], column: 'A' }])!, /AND group has only "and"/)
  assert.match(shapeError([{ column: 'A', operator: 'empty', enabled: 'no' }])!, /enabled is true or false/)
  assert.match(shapeError([{ column: 'A', operator: 'date_gt', value: 5 }])!, /send "1000"/)
  assert.match(shapeError([{ or: Array.from({ length: 30 }, () => ({ and: [{ operator: 'running' },
    { operator: 'running' }] })) }])!, /at most 50 conditions/)
  const parsed = parseWhere([{ column: 'A', operator: 'empty', enabled: true },
    { or: [{ column: 'A', operator: 'empty', enabled: false }] }])
  assert.deepEqual(parsed, { where: [{ column: 'A', operator: 'empty' },
    { or: [{ column: 'A', operator: 'empty', enabled: false }] }] }, 'enabled: true is the default, not kept')
})

check('date values are checked, off conditions too', () => {
  const sheet = { columns: ['A'], runColumns: new Map() }
  assert.equal(checkWhere([{ column: 'A', operator: 'date_gte', value: 'Jan 31, 2024' }], sheet), null)
  assert.match(checkWhere([{ column: 'A', operator: 'date_gt', value: 'soon' }], sheet)!,
    /date_gt requires a date, like 2024-01-31/)
  assert.match(checkWhere([{ column: 'A', operator: 'date_lt' }], sheet)!, /requires a value/)
  assert.match(checkWhere([{ or: [{ column: 'Z', operator: 'empty', enabled: false }] }], sheet)!, /Unknown column/)
})

check('activeWhere: off conditions out, then groups left with nothing on', () => {
  const off = { column: 'A', operator: 'empty', enabled: false } as const
  const on = { column: 'B', operator: 'empty' } as const
  assert.deepEqual(activeWhere([off, on, { or: [off, { and: [off] }] }, { and: [on, off] }]),
    [on, { and: [on] }])
  assert.deepEqual(activeWhere([off]), [])
  assert.match(allOffError([off, { or: [off] }], 'send all: true')!, /Every condition in where is turned off/)
  assert.equal(allOffError([off, on], 'x'), null)
  assert.equal(allOffError([], 'x'), null)
})

check('a view filter splits: each column\'s first on condition to its header, the rest to row_filter', () => {
  const where: WhereItem[] = [
    { column: 'A', operator: 'date_gt', value: '2024-01-01', enabled: false },
    { column: 'A', operator: 'date_lt', value: '2025-01-01' },
    { column: 'B', operator: 'empty' },
    { and: [{ column: 'C', operator: 'eq', value: 'x' }] },
  ]
  assert.deepEqual(splitWhere(where), {
    empty_filter: '{"B":"empty"}',
    column_filters: '{"A":{"type":"date_lt","value":"2025-01-01"}}',
    row_filter: JSON.stringify([where[0], where[3]]),
  })
  assert.deepEqual(parseRowFilter(JSON.stringify([where[0], { or: [{ column: 'A', operator: 'date_gt',
    value: 'nope' }] }, where[3]])), [where[0], where[3]], 'a stored item that no longer reads is dropped')
})

check('a rename rewrites nested groups; a delete leaves what passes every row out, never narrowing', () => {
  const rowFilter = (items: WhereItem[]) => ({ empty_filter: null, column_filters: null,
    row_filter: JSON.stringify(items) })
  const gone = { column: 'Gone', operator: 'empty' } as const
  const keep = { column: 'Keep', operator: 'not_empty' } as const
  const other = { column: 'Other', operator: 'eq', value: 'x' } as const
  const renamed = mapViewColumns(rowFilter([{ or: [{ and: [gone, keep] }] }]), renameTo('Gone', 'New'))
  assert.equal(renamed.row_filter, JSON.stringify([{ or: [{ and: [{ ...gone, column: 'New' }, keep] }] }]))
  const drop = (items: WhereItem[]) => mapViewColumns(rowFilter(items), dropColumn('Gone')).row_filter
  // AND(gone, keep) = keep; OR(that, other) stays; OR(gone, other) passes every row.
  assert.equal(drop([{ or: [{ and: [gone, keep] }, other] }]), JSON.stringify([{ or: [{ and: [keep] }, other] }]))
  assert.equal(drop([keep, { or: [gone, other] }]), JSON.stringify([keep]))
  assert.equal(drop([{ and: [{ or: [gone, keep] }, other] }]), JSON.stringify([{ and: [other] }]))
  assert.equal(drop([{ or: [{ and: [gone] }, other] }, keep]), JSON.stringify([keep]))
  // An off condition never counted: it just goes.
  assert.equal(drop([{ or: [{ ...gone, enabled: false }, other] }]), JSON.stringify([{ or: [other] }]))
  assert.equal(drop([{ or: [{ ...gone, enabled: false }] }]), null)
  // An AND group left with only off conditions passes every row, so its OR does too.
  assert.equal(drop([{ or: [other, { and: [gone, { ...keep, enabled: false }] }] }, keep]), JSON.stringify([keep]))
})

check('"Only run if": is before, after, on, not on, on or before, on or after', () => {
  const rule = (text: string, data: Record<string, string>) => rulePasses(checkRule(text, Object.keys(data)).tree, data)
  const row = { Signed: 'Jan 31, 2024 10:00' }
  assert.equal(rule('{{Signed}} is before "2024-02-01"', row), true)
  assert.equal(rule('{{Signed}} is after 2024-01-31', row), false)
  assert.equal(rule('{{Signed}} is on "31.1.2024"', row), true)
  assert.equal(rule('{{Signed}} is not on 2024-01-30', row), true)
  assert.equal(rule('{{Signed}} is on or before 2024-01-31 AND {{Signed}} is on or after "2024-01-31"', row), true)
  assert.equal(rule('{{Signed}} is not on 2024-01-30', { Signed: 'soon' }), false, 'no date: no date check passes')
  assert.equal(rule('{{Signed}} is before 2030-01-01', { Signed: '⏳ Processing...' }), false)
  assert.equal(checkRule('{{Signed}} is on or after 2024-01-31', ['Signed']).rule,
    '{{Signed}} is on or after "2024-01-31"')
  assert.equal(renameRuleColumn('{{Signed}} is before "2024-02-01"', 'Signed', 'Joined'),
    '{{Joined}} is before "2024-02-01"')
  assert.throws(() => checkRule('{{Signed}} is before "soon"', ['Signed']), /"soon" isn't a date/)
  assert.throws(() => checkRule('{{Signed}} is not before 2024-01-01', ['Signed']), /is on or after/)
  assert.throws(() => checkRule('{{Signed}} is not on or after 2024-01-01', ['Signed']), /is before/)
  assert.equal(rule('{{Signed}} is "on"', { Signed: 'ON' }), true, 'a quoted "on" is still text')
  assert.throws(() => checkRule('{{Signed}} > 2024-01-31', ['Signed']), /compares numbers. For dates write is before/)
  assert.throws(() => checkRule('{{Signed}} <= "Jan 31, 2024"', ['Signed']), /is on or after "Jan 31, 2024"/)
  assert.equal(checkRule('{{N}} > 50', ['N']).rule, '{{N}} > 50')
  assert.throws(() => checkRule('{{Signed}} is on "constructor 1, 2024"', ['Signed']), /isn't a date/)
})

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll date, group and off-condition assertions passed.')
