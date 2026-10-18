// The run controls' words (client/src/lib/run-controls-copy.ts): the column
// menu's items with their numbers, the header badge, a run's confirm from its
// estimate and a cell's play button. Pure, no DB.
import assert from 'node:assert/strict'
import {
  confirmMessage, costText, failedBadge, rowCostLabel, rowCostShort, runItemLabel,
} from '../../client/src/lib/run-controls-copy'
import type { RunControlEstimate } from '../../client/src/utils/api/run-controls'

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

const counts = { kind: 'ai' as const, column: 'Summary (Output)', total: 1200, empty: 30, outOfDate: 12, failed: 1 }
const est = (over: Partial<RunControlEstimate>): RunControlEstimate => ({
  kind: 'ai', column: 'Summary (Output)', rows: 42, lowUsd: 0.0021, highUsd: 0.0063, basis: 'range',
  spendLimitUsd: null, reusedRows: 0, note: null, ...over,
})

check('menu items carry their numbers once counted', () => {
  assert.equal(runItemLabel('empty_or_out_of_date', counts), 'Run 42 empty or out-of-date rows')
  assert.equal(runItemLabel('failed', counts), 'Retry 1 failed row')
  assert.equal(runItemLabel('all', counts), 'Force run all 1,200 rows')
  assert.equal(runItemLabel('all', null), 'Force run all rows')
  assert.equal(runItemLabel('empty_or_out_of_date', null), 'Run empty or out-of-date rows')
  assert.equal(runItemLabel('empty_or_out_of_date', { ...counts, empty: 0, outOfDate: 1 }),
    'Run 1 empty or out-of-date row')
})

check('the header badge', () => assert.equal(failedBadge(1234), '1,234 failed, retry'))

check('costs: a range, one price, a waterfall\'s average and most, none', () => {
  assert.equal(costText(est({})), '$0.0021 to $0.0063')
  assert.equal(costText(est({ lowUsd: 0.5, highUsd: 0.5 })), 'about $0.500')
  assert.equal(costText(est({ basis: 'average_max', lowUsd: 0.01, highUsd: 0.05 })), 'about $0.010, at most $0.050')
  assert.equal(costText(est({ lowUsd: null, highUsd: null })), null)
})

check('the confirm says which rows, what they cost, where the run stops', () => {
  assert.equal(confirmMessage('empty_or_out_of_date', est({})),
    'Run 42 rows that are empty or out of date? Any out-of-date results are replaced. Estimated $0.0021 to $0.0063.')
  assert.equal(confirmMessage('failed', est({ rows: 1, kind: 'enrichment', spendLimitUsd: 0.1 })),
    'Run 1 row that failed? Estimated $0.0021 to $0.0063. The run stops at $0.100.')
  assert.equal(confirmMessage('all', est({ kind: 'http', lowUsd: null, highUsd: null, note: 'No price.' })),
    'Run all 42 rows? Their current results are replaced. No price.')
  assert.equal(confirmMessage('empty_or_out_of_date', est({ rows: 0 })), 'No row here is empty or out of date.')
  assert.equal(confirmMessage('failed', est({ rows: 0 })), 'No rows here failed.')
})

check('a cell\'s play button', () => {
  assert.equal(rowCostLabel(est({ rows: 1 })), 'Run this row, $0.0021 to $0.0063')
  assert.equal(rowCostLabel(est({ rows: 1, kind: 'http', lowUsd: null, highUsd: null })), 'Run this row (1 request)')
  assert.equal(rowCostLabel(est({ rows: 1, reusedRows: 1 })), 'Run this row ($0, answer found before)')
  assert.equal(rowCostLabel(est({ rows: 0 })), 'Nothing to run')
  // On the button itself: the price first and short (a cell is narrow).
  assert.equal(rowCostShort(est({ rows: 1 })), '$0.0021 to $0.0063')
  assert.equal(rowCostShort(est({ rows: 1, lowUsd: 0.002, highUsd: 0.002 })), '$0.0020')
  assert.equal(rowCostShort(est({ rows: 1, basis: 'average_max', lowUsd: 0.01, highUsd: 0.05 })), '~$0.010, max $0.050')
  assert.equal(rowCostShort(est({ rows: 1, kind: 'http', lowUsd: null, highUsd: null })), '1 request')
  assert.equal(rowCostShort(est({ rows: 1, reusedRows: 1 })), '$0')
})

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`)
  process.exit(1)
}
console.log('all run-controls client checks passed')
