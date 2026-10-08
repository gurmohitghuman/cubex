import React, { useState } from 'react'
import { Play } from 'lucide-react'
import { ConfirmDialog } from '../ConfirmDialog'
import { plural } from '@/lib/utils'
import { formatCost } from '@/components/ai-modal/format'
import { ENRICH_TEST_ROWS } from '@/lib/constants'
import type { EnrichEstimate } from '@/utils/api'
import { effectiveMode, type EnrichDraft, type RowCounts } from './draft'
import { continuing, runRequest } from './run-request'
import { useRunStart } from './useRunStart'

interface Props {
  sheetId: string
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  rows: number | null
  counts: RowCounts
  selectedRows: number[]
  rowGeneration?: number
  order: string[]
  // What still stops a run (null: nothing), and whether the cost is known.
  problem: string | null
  estimate: EnrichEstimate | null
  unpriced: boolean
  onCancel: () => void
  onRunStarted: (runId: string) => void
}

// Set up's footer: Run on 5 rows (a real run on the first matching rows), and
// Run all, which first repeats the estimate in a confirm. A run's column stays
// with the draft, so the next run adds to it (the rows not enriched yet).
export const RunButtons: React.FC<Props> = (p) => {
  const [confirming, setConfirming] = useState(false)
  const { start, starting, error } = useRunStart(p.sheetId, (runId, statusColumn) => {
    p.update({ continueColumn: statusColumn, columnName: statusColumn })
    p.onRunStarted(runId)
  })
  const waiting = !p.unpriced && !p.estimate ? 'Waiting for the estimate…' : null
  const blocked = p.problem ?? waiting
  const more = continuing(p.draft)
  const choice = (test: boolean) => ({
    mode: effectiveMode(p.draft.rowsMode, p.counts), selectedRows: p.selectedRows, test, order: p.order, rowGeneration: p.rowGeneration,
  })
  const testRows = Math.max(1, Math.min(ENRICH_TEST_ROWS, p.rows ?? ENRICH_TEST_ROWS))
  const est = p.estimate?.estimate
  const limit = p.draft.spendLimitUsd ?? est?.highUsd ?? null
  const message = p.unpriced
    ? `Run ${p.draft.card?.title ?? 'this enrichment'} on ${more ? 'the rows not enriched yet' : plural(p.rows ?? 0, 'row')}? Your provider bills these calls directly.`
    : `Run ${p.draft.card?.title ?? 'this enrichment'} on ${more ? 'the rows not enriched yet' : plural(p.rows ?? 0, 'row')}? `
      + `Estimated ${formatCost(est?.lowUsd ?? 0)} to ${formatCost(est?.highUsd ?? 0)}.`
      + (limit !== null ? ` The run stops at ${formatCost(limit)}.` : '')
      + (p.estimate?.dailyLimit.limitUsd != null ? ` Today's limit: ${formatCost(p.estimate.dailyLimit.limitUsd)}, ${formatCost(p.estimate.dailyLimit.remainingUsd ?? 0)} left.` : '')

  return (
    <div className="flex flex-col items-end gap-1 pt-4 border-t border-gray-200">
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={p.onCancel} className="btn-secondary">Cancel</button>
        <button type="button" disabled={!!blocked || starting} className="btn-secondary" onClick={() => setConfirming(true)}
          data-testid="enrich-run-all">
          {more ? 'Run the rest' : `Run all${p.rows !== null ? ` ${p.rows.toLocaleString()}` : ''}`}
        </button>
        <button type="button" disabled={!!blocked || starting} className="btn-primary flex items-center gap-1.5"
          onClick={() => start(runRequest(p.draft, choice(true)))} data-testid="enrich-run-test">
          <Play className="h-4 w-4" />Run on {plural(testRows, 'row')}
        </button>
      </div>
      <p className={`text-xs ${error ? 'text-red-600' : 'text-gray-500'}`} data-testid="enrich-run-reason">
        {error ?? blocked ?? (more ? 'Runs add to the column you already made, on rows not enriched yet.' : 'Try it on a few rows first, then run the rest.')}
      </p>
      <ConfirmDialog isOpen={confirming} title="Run the enrichment" message={message} confirmText="Run"
        zClassName="z-[20010]" isLoading={starting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); start(runRequest(p.draft, choice(false))) }} />
    </div>
  )
}
