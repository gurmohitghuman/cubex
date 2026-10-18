// What a usage read asks for (lib/usage-query.ts, pure): the named ranges as
// whole UTC days (weeks from Monday, months and years turning over), a custom
// range checked, and group_by and limit.
import qMod from '../../server/src/lib/usage-query'
const { namedRange, parseUsageQuery, parseUsageRange, rangeBounds } =
  qMod as typeof import('../../server/src/lib/usage-query')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const at = (iso: string) => new Date(iso)
const span = (r: { from: string; to: string }) => `${r.from}..${r.to}`

const wed = at('2026-10-14T23:30:00Z')
check('this week runs Monday to today', span(namedRange('this_week', wed)) === '2026-10-12..2026-10-14')
check('last week is the Monday to Sunday before', span(namedRange('last_week', wed)) === '2026-10-05..2026-10-11')
check('this month starts on the 1st', span(namedRange('this_month', wed)) === '2026-10-01..2026-10-14')
check('last month is the whole month before', span(namedRange('last_month', wed)) === '2026-09-01..2026-09-30')
const sunday = at('2026-10-18T08:00:00Z')
check('on a Sunday the week still began on Monday', span(namedRange('this_week', sunday)) === '2026-10-12..2026-10-18')
const monday = at('2026-10-19T00:00:01Z')
check('on a Monday the week is that day', span(namedRange('this_week', monday)) === '2026-10-19..2026-10-19')
const january = at('2026-01-05T12:00:00Z')
check('last month in January is December', span(namedRange('last_month', january)) === '2025-12-01..2025-12-31')
const newYear = namedRange('last_week', at('2026-01-01T12:00:00Z'))
check('last week can span the year', span(newYear) === '2025-12-22..2025-12-28')
check('a leap February', span(namedRange('last_month', at('2028-03-10T00:00:00Z'))) === '2028-02-01..2028-02-29')

const ok = (r: ReturnType<typeof parseUsageRange>) => ('ok' in r ? r.ok : null)
check('nothing asked: this month', ok(parseUsageRange({}, wed))?.range === 'this_month')
const custom = ok(parseUsageRange({ from: '2026-09-15', to: '2026-10-02' }, wed))
check('two days make a custom range', custom?.range === 'custom' && span(custom) === '2026-09-15..2026-10-02')
check('a day that does not exist is refused', 'error' in parseUsageRange({ from: '2026-02-30', to: '2026-03-01' }, wed))
check('from after to is refused', 'error' in parseUsageRange({ from: '2026-10-02', to: '2026-10-01' }, wed))
check('only one end is refused', 'error' in parseUsageRange({ from: '2026-10-02' }, wed))
check('a range and days together are refused', 'error' in parseUsageRange({ range: 'this_week', from: '2026-10-01',
  to: '2026-10-02' }, wed))
check('an unknown range is refused', 'error' in parseUsageRange({ range: 'yesterday' }, wed))
check('ten years at most', 'error' in parseUsageRange({ from: '2000-01-01', to: '2026-01-01' }, wed))
const b = rangeBounds({ range: 'custom', from: '2026-10-01', to: '2026-10-31' })
check('bounds cover the last day whole', b.start === '2026-10-01 00:00:00' && b.end === '2026-11-01 00:00:00')

const q = parseUsageQuery({}, wed)
check('defaults: by column, 200 rows, this month',
  'ok' in q && q.ok.groupBy === 'column' && q.ok.limit === 200 && q.ok.range.range === 'this_month')
const run = parseUsageQuery({ group_by: 'run', limit: '50', range: 'last_week' }, wed)
check('a query string\'s limit is read', 'ok' in run && run.ok.limit === 50 && run.ok.groupBy === 'run')
check('an unknown grouping is refused', 'error' in parseUsageQuery({ group_by: 'sheet' }, wed))
check('limit is bounded',
  'error' in parseUsageQuery({ limit: 0 }, wed) && 'error' in parseUsageQuery({ limit: 5000 }, wed))

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall usage query checks passed')
