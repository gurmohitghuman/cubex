import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ConfirmDialog } from '../ConfirmDialog'
import { plural } from '@/lib/utils'
import { spent } from '@/lib/enrich-format'
import { type OnStarted, effectiveMode, type EnrichDraft } from './draft'
import { runRequest } from './run-request'
import { useSetupModel } from './useSetupModel'
import { useRunStart } from './useRunStart'
import { EstimateBox } from './EstimateBox'
import { RunResultRows } from './RunResultRows'
import { PausedNotice } from './PausedNotice'
import { runActive, type EnrichRunControls } from './useEnrichRun'
import { confirmMessage, quotedLimit } from './RunButtons'
import { ListTestPanel } from './ListTestPanel'

interface Props {
  sheetId: string
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  columns: string[]
  selectedCount: number
  selectedRows: number[]
  rowGeneration?: number
  hasKey: boolean | undefined
  active: boolean
  filledColumns: Set<string> | null
  run: EnrichRunControls
  onBack: () => void
  onStarted: OnStarted
}

// A list job's test names its sheet only when rows went there.
function doneLine(s: NonNullable<EnrichRunControls['status']>): string {
  const l = s.list
  if (!l) return 'Done. Check the rows here and in the sheet.'
  if (l.added + l.adding.results > 0) return `Done. Check the rows here and in ${l.destName ?? 'the other sheet'}.`
  return l.waitingFields.results > 0 ? 'Done. Pick the fields below to add these results as rows.'
    : 'Done. Check the rows here.'
}

function headline(s: NonNullable<EnrichRunControls['status']>): string {
  if (s.status === 'pending') return s.totalRows > 0 ? 'Starting the test rows…' : 'Getting the test rows ready…'
  if (s.status === 'running') return `Running on ${plural(s.totalRows, 'row')}…`
  if (s.status === 'paused') return 'The test run is paused.'
  if (s.status === 'completed') {
    return s.totalRows === 0
      ? 'No rows could run: they are missing an input.' : doneLine(s)
  }
  if (s.status === 'cancelled') return 'The test run was stopped.'
  return `The test run stopped: ${s.message ?? 'something went wrong.'}`
}

// Step 3, after "Run on 5 rows": the rows as the grid shows them, what each
// cost, and an estimate for the rows of the column not enriched yet. "Run on
// N more rows" adds to the same column; "Back to setup" keeps the column, so a
// changed setup tests again on the next rows.
export const TestStep: React.FC<Props> = (p) => {
  // The draft now adds to its column: its rows are the ones not enriched yet.
  const s = p.run.status
  const m = useSetupModel({ ...p, countsKey: s?.status })
  const { start, starting, error } = useRunStart(p.sheetId, p.onStarted)
  const [confirming, setConfirming] = useState(false)
  const running = runActive(s)
  const results = s ? [...s.latest].sort((a, b) => a.rowIndex - b.rowIndex) : []
  const est = m.estimate.estimate
  const billed = m.unpriced || m.ownKeySingle
  const waiting = running ? 'Waiting for the test rows to finish…'
    : !m.ready ? 'Loading the enrichment…' : !billed && !est ? 'Waiting for the estimate…' : null
  // A list job's next rows need the fields picked here first; a finished test
  // whose rows returned no results has none to pick yet.
  const l = s?.list
  const nothingFound = !!p.draft.list && !p.draft.list.fields && s?.status === 'completed' && !!l
    && l.added + l.adding.rows + l.waitingFields.rows + l.waitingRoom.rows === 0
    ? 'No fields to pick yet: no test row returned results. Go back to setup to run on the next rows.' : null
  const blocked = waiting ?? m.problem ?? nothingFound ?? m.fullProblem
  // Like Set up's full run: a confirm with the estimate, and the limit it quotes is kept.
  const quote = { draft: p.draft, rows: m.rows, estimate: est, unpriced: billed, listDest: m.listDestName }
  const more = () => start(runRequest(p.draft, {
    mode: effectiveMode(p.draft.rowsMode, m.counts), selectedRows: p.selectedRows, test: false, order: m.order,
    rowGeneration: p.rowGeneration, status: 'not_enriched', spendLimitUsd: quotedLimit(quote),
  }), false)

  return (
    <div className="p-4 space-y-3" data-testid="enrich-test-step">
      {!s ? (
        <p className="text-sm text-gray-600 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />Loading…
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-gray-800" data-testid="enrich-test-status">
            {running && <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />}
            <span>{headline(s)}</span>
          </div>
          <PausedNotice status={s} run={p.run} />
          {results.length > 0 && (
            <RunResultRows results={results} statusColumn={s.statusColumn} outputColumns={s.outputColumns} />
          )}
          {p.draft.list && s.statusColumn && (
            <ListTestPanel sheetId={p.sheetId} column={s.statusColumn} list={p.draft.list} updateList={m.updateList}
              status={s} running={running} active={p.active} onAdded={p.run.refresh} />
          )}
          <p className="text-xs text-gray-600" data-testid="enrich-test-spent">
            Spent {spent(s.spentUsd)} on {plural(results.length, 'row')} so far.
            {s.skippedRows > 0 && ` ${plural(s.skippedRows, 'row')} had an empty input and cost nothing.`}
          </p>
        </>
      )}
      {(p.run.loadError || p.run.actionError) && (
        <p className="text-xs text-red-600">{p.run.actionError ?? p.run.loadError}</p>
      )}

      {m.rows === 0 ? (
        <p className="text-sm text-gray-700">
          Every row of this column has run. To run some again, go back to setup.
        </p>
      ) : (
        <EstimateBox estimate={est} loading={m.estimate.loading} error={m.estimate.error} rows={m.rows}
          balance={m.data.balance} spendLimit={p.draft.spendLimitUsd} missNote={m.missNote} ownKeys={m.ownKeys}
          blocked={m.blocked} unpriced={m.unpriced} ownKeySingle={m.ownKeySingle} ownKeyProvider={m.ownKeyProvider}
          listDest={m.listDestName}
          label={m.rows === null ? undefined : `Estimated for the other ${plural(m.rows, 'row')}`} />
      )}

      <div className="flex flex-col items-end gap-1 pt-4 border-t border-gray-200">
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={p.onBack} data-testid="enrich-back-setup">
            Back to setup
          </button>
          {m.rows !== 0 && (
            <button type="button" className="btn-primary" disabled={!!blocked || starting || m.rows === null}
              onClick={() => setConfirming(true)} data-testid="enrich-run-more">
              Run on {m.rows === null ? 'the other rows' : `${plural(m.rows, 'more row')}`}
            </button>
          )}
        </div>
        <p className={`text-xs ${error ? 'text-red-600' : 'text-gray-500'}`} data-testid="enrich-run-reason">
          {error ?? blocked ?? (p.draft.list
            ? 'Adds these results too, then runs the rows not enriched yet.'
            : 'Adds to the same column, on the rows not enriched yet.')}
        </p>
      </div>
      <ConfirmDialog isOpen={confirming} title="Run the enrichment" message={confirmMessage(quote)} confirmText="Run"
        zClassName="z-[20010]" isLoading={starting} onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); more() }} />
    </div>
  )
}
