import React, { useState } from 'react'
import { Play } from 'lucide-react'
import { ConfirmDialog } from '../ConfirmDialog'
import { plural } from '@/lib/utils'
import { formatCost } from '@/components/ai-modal/format'
import { spent } from '@/lib/enrich-format'
import { ENRICH_TEST_ROWS } from '@/lib/constants'
import type { EnrichEstimate } from '@/utils/api'
import { type OnStarted, effectiveMode, type EnrichDraft, type RowCounts } from './draft'
import { canTest, continuing, rowsPhrase, runRequest, runStatusOf } from './run-request'
import { useRunStart } from './useRunStart'

interface Props {
  sheetId: string
  draft: EnrichDraft
  // The rows a full run takes: counted by status on a column a run already made.
  rows: number | null
  counts: RowCounts
  selectedRows: number[]
  rowGeneration?: number
  order: string[]
  // What still stops a run (null: nothing), what stops only a full run (a
  // list job's fields come from a test's results), and whether the cost is known.
  problem: string | null
  fullProblem?: string | null
  estimate: EnrichEstimate | null
  unpriced: boolean
  onCancel: () => void
  // A run started: Run on 5 rows shows the Test step, a full run the Run step.
  onStarted: OnStarted
  // The start refused one field (a new sheet's name): shown at that field.
  onFieldError?: (field: string, message: string) => void
  // A list job's destination sheet, for the confirm's "May add up to N rows".
  listDest?: string | null
}

// The run limit a full run shows and keeps: the one typed, else the estimate's high end.
export const quotedLimit = (p: Pick<Props, 'draft' | 'estimate' | 'unpriced'>): number | null =>
  (p.unpriced ? null : p.draft.spendLimitUsd ?? p.estimate?.estimate.highUsd ?? null)

// The confirm before a full run repeats the estimate for the rows it takes.
export function confirmMessage(p: Pick<Props, 'draft' | 'rows' | 'estimate' | 'unpriced' | 'listDest'>): string {
  const title = p.draft.card?.title ?? 'this enrichment'
  const more = continuing(p.draft)
  const status = runStatusOf(p.draft)
  const list = p.draft.list ? p.estimate?.list ?? null : null
  const what = `Run ${title} on ${rowsPhrase(p.rows ?? 0, status, more)}?`
    + (list ? ` May add up to ${plural(list.addUpTo, 'row')} to ${p.listDest || 'the other sheet'}.` : '')
  const again = !more || status === 'not_enriched' ? ''
    : list ? ' The rows each one added before are replaced.'
      : p.rows === 1 ? ' Its current result is replaced.' : ' Their current results are replaced.'
  if (p.unpriced) return `${what}${again} Your provider bills these calls directly.`
  const est = p.estimate?.estimate
  const limit = quotedLimit(p)
  const daily = p.estimate?.dailyLimit
  return `${what}${again} Estimated ${spent(est?.lowUsd ?? 0)} to ${spent(est?.highUsd ?? 0)}.`
    + (limit !== null ? ` The run stops at ${formatCost(limit)}.` : '')
    + (daily?.limitUsd != null
      ? ` Today's limit: ${formatCost(daily.limitUsd)}, ${formatCost(daily.remainingUsd ?? 0)} left.` : '')
}

// Set up's footer: Run on 5 rows (a real run on the first matching rows), and
// the full run, which first repeats the estimate in a confirm. A run's column
// stays with the draft, so the next run adds to it, on the rows picked by
// status (not enriched yet unless chosen otherwise).
export const RunButtons: React.FC<Props> = (p) => {
  const [confirming, setConfirming] = useState(false)
  const { start, starting, error } = useRunStart(p.sheetId, p.onStarted, p.onFieldError)
  const waiting = !p.unpriced && !p.estimate ? 'Waiting for the estimate…' : null
  const blocked = p.problem ?? waiting
  const fullBlocked = blocked ?? p.fullProblem ?? null
  const more = continuing(p.draft)
  const testable = canTest(p.draft)
  const choice = (test: boolean) => ({
    mode: effectiveMode(p.draft.rowsMode, p.counts), selectedRows: p.selectedRows, test, order: p.order,
    rowGeneration: p.rowGeneration,
  })
  // No rows match (both buttons are off then): the labels don't count them.
  const known = p.rows === null || p.rows === 0 ? null : p.rows
  const testRows = Math.min(ENRICH_TEST_ROWS, known ?? ENRICH_TEST_ROWS)
  const count = known !== null ? ` ${known.toLocaleString()}` : ''
  const fullLabel = more ? `Run on ${known === null ? 'these rows' : plural(known, 'row')}` : `Run all${count}`
  const reason = more
    ? 'Runs add to the column you already made.'
    : 'Try it on a few rows first, then run the rest.'

  return (
    <div className="flex flex-col items-end gap-1 pt-4 border-t border-gray-200">
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={p.onCancel} className="btn-secondary">Cancel</button>
        <button type="button" disabled={!!fullBlocked || starting} onClick={() => setConfirming(true)}
          className={testable ? 'btn-secondary' : 'btn-primary'} data-testid="enrich-run-all">
          {fullLabel}
        </button>
        {testable && (
          <button type="button" disabled={!!blocked || starting} className="btn-primary flex items-center gap-1.5"
            onClick={() => start(runRequest(p.draft, choice(true)), true)} data-testid="enrich-run-test">
            <Play className="h-4 w-4" />Run on {plural(testRows, 'row')}
          </button>
        )}
      </div>
      <p className={`text-xs ${error ? 'text-red-600' : 'text-gray-500'}`} data-testid="enrich-run-reason">
        {error ?? blocked ?? p.fullProblem ?? reason}
      </p>
      <ConfirmDialog isOpen={confirming} title="Run the enrichment" message={confirmMessage(p)} confirmText="Run"
        zClassName="z-[20010]" isLoading={starting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          start(runRequest(p.draft, { ...choice(false), spendLimitUsd: quotedLimit(p) }), false)
        }} />
    </div>
  )
}
