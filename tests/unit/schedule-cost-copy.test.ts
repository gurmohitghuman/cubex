// The Scheduled reruns drawer's cost line (client/src/components/schedules/schedule-cost-copy.ts, pure): a range, one
// price, nothing, under a cent; rows as the most any column of a sheet runs, summed over a table's sheets; an HTTP API
// column's requests with no price; a column with no known price named; no rows to run.
import assert from 'node:assert/strict'
import { costWords } from '../../client/src/components/schedules/schedule-cost-copy'
import type { ColumnEstimate, ColumnRunEstimate } from '../../client/src/utils/api/column-runs'

const col = (o: Partial<ColumnEstimate>): ColumnEstimate => ({
  column: 'Fit', kind: 'ai', layer: 1, rows: 3, low_usd: 0.1, high_usd: 0.4, row_most_usd: 0.2,
  sends_requests: false, at_most: false, note: null, ...o,
})
const est = (columns: ColumnEstimate[], unpriced: string[] = []): ColumnRunEstimate => {
  const priced = columns.filter(c => !c.sends_requests && c.high_usd !== null)
  const sum = (k: 'low_usd' | 'high_usd') => priced.reduce((n, c) => n + (c[k] ?? 0), 0)
  return { rows_in_scope: 1200, unpriced, columns, row_most_usd: 0, low_usd: sum('low_usd'), high_usd: sum('high_usd') }
}

let failures = 0
function check(label: string, got: string, want: string) {
  try { assert.equal(got, want); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

check('a range', costWords([est([col({})])]), 'A run now would cost about $0.10 to $0.40 for 3 rows.')
check('one price, the most rows any column runs', costWords([est([col({ low_usd: 0.5, high_usd: 0.5, rows: 1 }),
  col({ column: 'Email', kind: 'enrichment', rows: 1200, low_usd: 0, high_usd: 0 })])]),
'A run now would cost about $0.50 for 1,200 rows.')
check('free', costWords([est([col({ rows: 1, low_usd: 0, high_usd: 0 })])]), 'A run now would cost nothing for 1 row.')
check('under a cent', costWords([est([col({ low_usd: 0.001, high_usd: 0.004 })])]),
  'A run now would cost less than $0.01 for 3 rows.')
check('from under a cent', costWords([est([col({ low_usd: 0.004, high_usd: 0.4 })])]),
  'A run now would cost about $0.00 to $0.40 for 3 rows.')
check("a table's sheets add up", costWords([est([col({})]), est([col({ rows: 2 })])]),
  'A run now would cost about $0.20 to $0.80 for 5 rows.')
const ping = col({ column: 'Ping', kind: 'http', rows: 4, low_usd: null, high_usd: null, row_most_usd: null,
  sends_requests: true })
check('and an HTTP API column', costWords([est([col({}), ping])]),
  'A run now would cost about $0.10 to $0.40 for 4 rows, and send 4 requests to your API, which Cubex has no price '
  + 'for.')
check('an HTTP API column alone', costWords([est([ping])]),
  'A run now would send 4 requests to your API, which Cubex has no price for.')
check('a column with no known price', costWords([est([col({ low_usd: null, high_usd: null })], ['Fit'])]),
  'A run now would run 3 rows. Fit has no price here.')
check('no rows to run', costWords([est([col({ rows: 0 })])]), 'A run now would find no rows to run.')
check('nothing to price at all', costWords([]), 'A run now would find no rows to run.')

if (failures > 0) { console.error(`${failures} schedule-cost-copy check(s) failed`); process.exit(1) }
console.log('schedule-cost-copy: all assertions passed')
