// The words of the run controls (pure): the column menu's items with their
// numbers, a run's confirm from its estimate, and a cell's play button.
// Plain words, no em dashes.
import { formatCost } from '../components/ai-modal/format'
import { plural } from './utils'
import type { RunControlEstimate, RunCounts, RunRows } from '../utils/api/run-controls'

const n = (v: number) => v.toLocaleString()

// The menu's items, with their numbers once counted (null while counting).
export function runItemLabel(rows: RunRows, c: RunCounts | null): string {
  if (rows === 'empty_or_out_of_date') {
    return c ? `Run ${plural(c.empty + c.outOfDate, 'empty or out-of-date row')}` : 'Run empty or out-of-date rows'
  }
  if (rows === 'failed') return c ? `Retry ${plural(c.failed, 'failed row')}` : 'Retry failed rows'
  return c ? `Force run all ${plural(c.total, 'row')}` : 'Force run all rows'
}

// The header's badge.
export const failedBadge = (failed: number): string => `${n(failed)} failed, retry`

export const CONFIRM_TITLE: Record<RunRows, string> = {
  empty_or_out_of_date: 'Run empty or out-of-date rows', failed: 'Retry failed rows', all: 'Force run all rows',
}

const money = (v: number) => (v === 0 ? '$0' : formatCost(v))

// What the rows could cost, or null when no price is known.
export function costText(e: RunControlEstimate): string | null {
  if (e.lowUsd === null || e.highUsd === null) return null
  if (e.basis === 'average_max') return `about ${money(e.lowUsd)}, at most ${money(e.highUsd)}`
  return e.lowUsd === e.highUsd ? `about ${money(e.lowUsd)}` : `${money(e.lowUsd)} to ${money(e.highUsd)}`
}

const WHAT: Record<RunRows, (rows: number) => string> = {
  empty_or_out_of_date: r => `${plural(r, 'row')} that ${r === 1 ? 'is' : 'are'} empty or out of date`,
  failed: r => `${plural(r, 'row')} that failed`,
  all: r => (r === 1 ? 'its 1 row' : `all ${n(r)} rows`),
}

export function confirmMessage(rows: RunRows, e: RunControlEstimate): string {
  if (e.rows === 0) {
    return rows === 'failed' ? 'No rows here failed.'
      : rows === 'all' ? 'There are no rows to run.' : 'No row here is empty or out of date.'
  }
  const cost = costText(e)
  const replaced = rows === 'empty_or_out_of_date' ? ' Any out-of-date results are replaced.'
    : rows === 'all' ? ' Their current results are replaced.' : ''
  const priced = cost ? ` Estimated ${cost}.` : ''
  const limit = e.spendLimitUsd !== null ? ` The run stops at ${formatCost(e.spendLimitUsd)}.` : ''
  const reused = e.reusedRows > 0 ? ` ${plural(e.reusedRows, 'row')} reuse an answer found before, at $0.` : ''
  return `Run ${WHAT[rows](e.rows)}?${replaced}${priced}${limit}${reused}${e.note ? ` ${e.note}` : ''}`
}

// A cell's play button, once its row is priced: the cost first and short (a
// cell is narrow), the whole sentence in its tooltip (rowCostLabel).
export function rowCostShort(e: RunControlEstimate): string {
  if (e.rows === 0) return 'Nothing to run'
  if (e.reusedRows > 0) return '$0'
  if (e.lowUsd !== null && e.highUsd !== null) {
    if (e.basis === 'average_max') return `~${money(e.lowUsd)}, max ${money(e.highUsd)}`
    return e.lowUsd === e.highUsd ? money(e.lowUsd) : `${money(e.lowUsd)} to ${money(e.highUsd)}`
  }
  return e.kind === 'http' ? '1 request' : 'Run'
}

export function rowCostLabel(e: RunControlEstimate): string {
  if (e.rows === 0) return 'Nothing to run'
  if (e.reusedRows > 0) return 'Run this row ($0, answer found before)'
  const cost = costText(e)
  return cost ? `Run this row, ${cost}` : e.kind === 'http' ? 'Run this row (1 request)' : 'Run this row'
}

// A run that paused itself and left its reason in error_message: its provider
// failing row after row, results that couldn't be saved, a worker that kept
// stopping (server lib/run-pool.ts, services/stalled-runs.ts).
const SELF_PAUSES = new Set(['provider_errors', 'storage', 'stalled'])
export const selfPaused = (reason: string | null | undefined): boolean => !!reason && SELF_PAUSES.has(reason)
