// The column menu's enrichment reruns (pure): which rows each action takes,
// and its confirm's words, from the server's estimate (rows counted by status,
// the price range, where the run stops and today's limit). Plain words, no em
// dashes; formatCost and plural.
import type { EnrichRerunEstimate, EnrichRowsStatus } from '@/utils/api'
import { formatCost } from '../ai-modal/format'
import { plural } from '../../lib/utils'
import { spent } from '../../lib/enrich-format'
import { reuseConfirmLine } from './reuse-copy'

// stale: rows not enriched yet, and rows whose result was made from input cells that changed since.
export type RerunAction = 'stale' | 'failed' | 'selected' | 'all'

export const RERUN_STATUS: Record<RerunAction, EnrichRowsStatus> = {
  stale: 'empty_or_out_of_date', failed: 'failed', selected: 'any', all: 'any',
}

export const RERUN_TITLE: Record<RerunAction, string> = {
  stale: 'Run empty or out-of-date rows', failed: 'Retry failed rows',
  selected: 'Run selected rows', all: 'Force run all rows',
}

function rowsText(action: RerunAction, n: number): string {
  if (action === 'stale') return `${plural(n, 'row')} that ${n === 1 ? 'is' : 'are'} empty or out of date`
  if (action === 'failed') return `${plural(n, 'row')} that failed`
  if (action === 'selected') return `${plural(n, 'selected row')}`
  return n === 1 ? 'its 1 row again' : `all ${n.toLocaleString()} rows again`
}

const NOTHING: Record<RerunAction, string> = {
  stale: 'No row in {col} is empty or out of date.',
  failed: 'No rows in {col} failed.',
  selected: 'None of the selected rows can run.',
  all: '{col} has no rows to run.',
}

export function rerunMessage(action: RerunAction, e: EnrichRerunEstimate): string {
  if (e.rows === 0) return NOTHING[action].replace('{col}', e.column)
  // The confirm opens from the column's own menu: no need to name it again.
  const list = e.addsRowsTo ?? null
  // Rows that reuse a found answer from an earlier run cost nothing again.
  const reused = e.reusedRows > 0
  const costs = reused ? '' : `, and ${e.rows === 1 ? 'it costs' : 'each row costs'} again`
  const replaced = action === 'stale' ? ' Any out-of-date results are replaced.'
    : list ? ` The rows ${e.rows === 1 ? 'it' : 'they'} added to ${list.name} earlier move to the trash${costs}.`
      : e.rows === 1 ? ` Its current result is replaced${costs}.` : ` Their current results are replaced${costs}.`
  const reuse = !reused ? ''
    : reuseConfirmLine(e.reusedRows, e.reuseComplete)
      + (action === 'stale' ? '' : ' To call them again, turn on Always call again in Edit enrichment.')
  const adds = list ? ` May add up to ${plural(list.addUpTo, 'row')} to ${list.name}.` : ''
  const head = `Run ${e.toolName} on ${rowsText(action, e.rows)}?${replaced}${reuse}${adds}`
  if (!e.priceKnown) return `${head} Your provider bills these calls directly.`
  const daily = e.dailyLimit.limitUsd !== null
    ? ` Today's limit: ${formatCost(e.dailyLimit.limitUsd)}, ${formatCost(e.dailyLimit.remainingUsd ?? 0)} left.` : ''
  return `${head} Estimated ${spent(e.lowUsd)} to ${spent(e.highUsd)}.`
    + (e.spendLimitUsd !== null ? ` The run stops at ${formatCost(e.spendLimitUsd)}.` : '')
    + daily
    + ' Rows missing an input are skipped and cost nothing.'
}
