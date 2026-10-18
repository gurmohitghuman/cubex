// The column menu's enrichment reruns (pure): which rows each action takes,
// and its confirm's words, from the server's estimate (rows counted by status,
// the price range, where the run stops and today's limit). Plain words, no em
// dashes; formatCost and plural.
import type { EnrichRerunEstimate, EnrichRowsStatus } from '@/utils/api'
import { formatCost } from '../ai-modal/format'
import { plural } from '../../lib/utils'
import { spent } from '../../lib/enrich-format'
import { reuseConfirmLine } from './reuse-copy'

export type RerunAction = 'not_enriched' | 'failed' | 'selected' | 'all'

export const RERUN_STATUS: Record<RerunAction, EnrichRowsStatus> = {
  not_enriched: 'not_enriched', failed: 'failed', selected: 'any', all: 'any',
}

export const RERUN_TITLE: Record<RerunAction, string> = {
  not_enriched: 'Run rows not enriched', failed: 'Retry failed rows',
  selected: 'Run selected rows', all: 'Run all rows again',
}

function rowsText(action: RerunAction, n: number): string {
  if (action === 'not_enriched') return `${plural(n, 'row')} not enriched yet`
  if (action === 'failed') return `${plural(n, 'row')} that failed`
  if (action === 'selected') return `${plural(n, 'selected row')}`
  return n === 1 ? 'its 1 row again' : `all ${n.toLocaleString()} rows again`
}

const NOTHING: Record<RerunAction, string> = {
  not_enriched: 'Every row in {col} is enriched already.',
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
  const replaced = action === 'not_enriched' ? ''
    : list ? ` The rows ${e.rows === 1 ? 'it' : 'they'} added to ${list.name} before are replaced${costs}.`
      : e.rows === 1 ? ` Its current result is replaced${costs}.` : ` Their current results are replaced${costs}.`
  const reuse = !reused ? ''
    : reuseConfirmLine(e.reusedRows, e.reuseComplete)
      + (action === 'not_enriched' ? '' : ' To call them again, turn on Always call again in Edit enrichment.')
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
