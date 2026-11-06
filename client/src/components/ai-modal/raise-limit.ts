// The "Raise the spend limit" dialog's checks and words (pure; RaiseLimitDialog.tsx).
// The least limit and the suggestion come from the server (services/ai-run-limit.ts),
// and amounts compare in micro-dollars as the server does (lib/cost-ceiling.ts micro):
// what the dialog lets through, the server takes. Plain words, no em dashes.
import type { AiLimitView } from '../../utils/api/types-search'
import { limitText, spent } from '../../lib/enrich-format'
import { plural } from '../../lib/utils'
import { formatCost } from './format'

export const microOf = (usd: number): number => Math.round(usd * 1e6)

// Under the least the run can go on with: the server refuses it (the run would only pause again).
export const tooLow = (value: number, view: Pick<AiLimitView, 'least_usd'>): boolean =>
  microOf(value) < microOf(view.least_usd)

// A run paused another way (by you, say) whose limit is used up: what it spent and
// its cut-off calls count leave no room, so the server takes a resume only with a
// higher limit, and Resume asks for one here instead.
export const limitUsedUp = (v: Pick<AiLimitView, 'limit_usd' | 'least_usd'>): boolean =>
  v.limit_usd !== null && microOf(v.least_usd) > microOf(v.limit_usd)

// Why the run stopped: the pause message it left, else the limit and what it spent.
export const pauseLine = (v: AiLimitView): string => v.message ?? (v.pause_reason === 'spend_limit'
  ? `The run reached its ${limitText(v.limit_usd ?? 0)} spend limit (${spent(v.spent_usd)} spent).`
  : `The run is paused, and its ${limitText(v.limit_usd ?? 0)} spend limit is used up.`)

// The least limit, exactly (to the micro-dollar the server counts), and what it is made of.
export function leastLine(v: AiLimitView): string {
  const cut = v.cut_off_usd > 0
    ? `, plus ${spent(v.cut_off_usd)} for calls cut off before they answered (they may still be billed)` : ''
  const parts = v.next_row_usd
    ? `what it spent (${spent(v.spent_usd)})${cut}, plus its next row at its most (${formatCost(v.next_row_usd)})`
    : `more than its old limit and what it spent (${spent(v.spent_usd)})${cut}`
  return `It needs at least ${limitText(v.least_usd)} to go on: ${parts}.`
}

// What the amount filled in is: the least, plus the rows left at what a row has cost so far.
export function suggestLine(v: AiLimitView): string {
  if (v.avg_row_usd === null) return 'The amount filled in is that least: no row has run yet to show what one costs.'
  if (v.rows_left < 1) return 'The amount filled in is that least.'
  return `The amount filled in is that least, plus the ${plural(v.rows_left, 'row')} left at what a row has `
    + `cost so far on average (${spent(v.avg_row_usd)}).`
}

// Enough to finish for sure, as words only: a row's most is a worst case, often far above what rows cost
// (null: unknown, or no more than the amount filled in).
export function finishLine(v: AiLimitView): string | null {
  if (v.finish_usd === null || microOf(v.finish_usd) <= microOf(v.suggest_usd)) return null
  return `To finish for sure, even if every row left costs its most, it would need ${limitText(v.finish_usd)}.`
}

export const tooLowLine = (v: AiLimitView): string => `Enter at least ${limitText(v.least_usd)}.`

// Resume all with more runs at their limit: they ask one after another.
export const queuedLine = (n: number): string | null => (n > 0
  ? `Then ${plural(n, 'more run')} that stopped at ${n === 1 ? 'its' : 'their'} spend limit, one at a time.` : null)
