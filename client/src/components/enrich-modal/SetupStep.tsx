import React from 'react'
import { AccordionSection } from '../AccordionSection'
import { TregNotice } from '../TregNotice'
import { LoadingSpinner } from '../LoadingSpinner'
import { formatCost } from '@/components/ai-modal/format'
import type { EnrichDraft } from './draft'
import { cardMeta } from './copy'
import { InputsPane, inputsSummary } from './InputsPane'
import { ProvidersPane, providersSummary } from './ProvidersPane'
import { EmailChecksPane, acceptSummary } from './EmailChecksPane'
import { OutputsPane, outputsSummary } from './OutputsPane'
import { RowsLimitsPane } from './RowsLimitsPane'
import { EstimateBox } from './EstimateBox'
import { RunButtons } from './RunButtons'
import { continuing } from './run-request'
import { useSetupModel } from './useSetupModel'

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
  onChangeTool: () => void
  onCancel: () => void
  onStarted: (runId: string, statusColumn: string, test: boolean) => void
  // Why no new run can start yet: a run on this column is still going (or loading).
  runBlock?: string | null
}

// Step 2: inputs mapped to columns, the waterfall's providers, outputs as new
// columns, rows and limits, the estimate, and the run buttons.
export const SetupStep: React.FC<Props> = (p) => {
  const { draft, update } = p
  const m = useSetupModel(p)
  const card = m.card
  if (!card) return null
  const est = m.estimate.estimate
  // A tool with no listed price, or one the provider bills, has no cap worth showing.
  const billed = m.unpriced || m.ownKeySingle
  const cap = billed ? null : draft.maxCostPerRowUsd ?? est?.defaultMaxCostPerRowUsd ?? null
  const more = continuing(draft)
  const rowsSummary = `${m.rows === null ? '…' : m.rows.toLocaleString()} rows`
    + (cap !== null ? ` · up to ${formatCost(cap)}/row` : '')
  const problem = !m.ready || !m.tool ? 'Loading the enrichment…'
    : p.runBlock ?? m.problem ?? (p.hasKey === false ? 'Add your treg key in Settings first.' : null)

  return (
    <div className="p-4 space-y-3">
      <TregNotice hasKey={p.hasKey} />
      <div className="flex items-start justify-between gap-3 border border-gray-200 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">{card.title}</p>
          <p className="text-xs text-gray-500">{cardMeta(card).join(' · ')}</p>
        </div>
        <button type="button" onClick={p.onChangeTool} className="text-xs text-gray-700 underline hover:no-underline">
          Change
        </button>
      </div>

      {m.data.toolError ? (
        <div className="border border-gray-200 p-3 text-sm text-gray-700 space-y-2">
          <p>{m.data.toolError}</p>
          <button type="button" onClick={m.data.retryTool} className="btn-secondary">Try again</button>
        </div>
      ) : !m.ready || !m.tool ? (
        <LoadingSpinner size="sm" message="Loading the enrichment…" className="py-8" />
      ) : (
        <>
          <div>
            <label htmlFor="enrich-column-name" className="block text-sm font-medium text-gray-700 mb-1">
              Column name
            </label>
            <input id="enrich-column-name" className={`input w-full ${m.statusNameProblem ? '!border-red-300' : ''}`}
              value={draft.columnName} onChange={e => update({ columnName: e.target.value })} />
            {m.statusNameProblem
              ? <p className="text-xs text-red-600 mt-1">{m.statusNameProblem}</p>
              : <p className="text-xs text-gray-500 mt-1">
                {more
                  ? 'Runs add to this column. Rename it to make a new column instead.'
                  : "Shows each row's result: found, not found, or why it failed."}
              </p>}
          </div>

          <AccordionSection title="Inputs" summary={inputsSummary(draft.bindings)} defaultOpen>
            <InputsPane tool={m.tool} bindings={draft.bindings} columns={p.columns}
              setBinding={(name, b) => {
                const next = { ...draft.bindings }
                if (b) next[name] = b; else delete next[name]
                update({ bindings: next })
              }}
              cleanDomains={draft.cleanDomains} setCleanDomains={v => update({ cleanDomains: v })} />
          </AccordionSection>

          {m.providers && (
            <AccordionSection title="Providers" summary={providersSummary(m.providers.rows, m.providers.stateOf)}>
              <ProvidersPane tool={m.tool} access={m.data.access} order={draft.providerOrder} skip={draft.skipProviders}
                stopAtFirst={draft.stopAtFirst} sent={m.sent} update={update} />
            </AccordionSection>
          )}

          {card.preset === 'verified_email' && (
            <AccordionSection title="Email checks" summary={acceptSummary(draft.emailChecks.accept)}>
              <EmailChecksPane value={draft.emailChecks} onChange={emailChecks => update({ emailChecks })} />
            </AccordionSection>
          )}

          {card.addsRows ? (
            <AccordionSection title="Add results as rows" summary="Another sheet" defaultOpen>
              <p className="text-xs text-gray-600">
                This job adds each result as a row in another sheet, with a link back to this row. Picking the sheet,
                the fields to keep and the number of results per row comes with list runs.
              </p>
            </AccordionSection>
          ) : (
            <AccordionSection title="Outputs" summary={outputsSummary(draft.outputs)} defaultOpen>
              <OutputsPane outputs={draft.outputs} onChange={outputs => update({ outputs })} />
              {m.outputNameProblem && <p className="text-xs text-red-600">{m.outputNameProblem}</p>}
            </AccordionSection>
          )}

          <AccordionSection title="Rows and limits" defaultOpen={more} summary={rowsSummary}>
            <RowsLimitsPane draft={draft} update={update} counts={m.counts} continuing={more} byStatus={m.byStatus}
              columns={p.columns} defaultMaxCostPerRow={est?.defaultMaxCostPerRowUsd ?? null}
              defaultSpendLimit={est?.estimate.highUsd ?? null} billedBy={billed ? m.ownKeyProvider : null} />
          </AccordionSection>

          <EstimateBox estimate={est} loading={m.estimate.loading} error={m.estimate.error} rows={m.rows}
            balance={m.data.balance} spendLimit={draft.spendLimitUsd} missNote={m.missNote} ownKeys={m.ownKeys}
            blocked={m.blocked} unpriced={m.unpriced} ownKeySingle={m.ownKeySingle} ownKeyProvider={m.ownKeyProvider} />
        </>
      )}

      <RunButtons sheetId={p.sheetId} draft={draft} rows={m.rows} counts={m.counts}
        selectedRows={p.selectedRows} rowGeneration={p.rowGeneration} order={m.order} estimate={est}
        problem={problem} unpriced={billed} onCancel={p.onCancel} onStarted={p.onStarted} />
    </div>
  )
}
