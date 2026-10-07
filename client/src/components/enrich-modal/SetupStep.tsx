import React from 'react'
import { Play } from 'lucide-react'
import { AccordionSection } from '../AccordionSection'
import { TregNotice } from '../TregNotice'
import { LoadingSpinner } from '../LoadingSpinner'
import { formatCost } from '@/components/ai-modal/format'
import { plural } from '@/lib/utils'
import { ENRICH_TEST_ROWS } from '@/lib/constants'
import type { EnrichDraft } from './draft'
import { cardMeta } from './copy'
import { InputsPane, inputsSummary } from './InputsPane'
import { ProvidersPane, providersSummary } from './ProvidersPane'
import { EmailChecksPane, acceptSummary } from './EmailChecksPane'
import { OutputsPane, outputsSummary } from './OutputsPane'
import { RowsLimitsPane } from './RowsLimitsPane'
import { EstimateBox } from './EstimateBox'
import { useSetupModel } from './useSetupModel'

interface Props {
  sheetId: string
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  columns: string[]
  selectedCount: number
  hasKey: boolean | undefined
  active: boolean
  filledColumns: Set<string> | null
  onChangeTool: () => void
  onCancel: () => void
}

// Step 2: inputs mapped to columns, the waterfall's providers, outputs as new
// columns, rows and limits, and the estimate. Runs arrive with the run engine.
export const SetupStep: React.FC<Props> = (p) => {
  const { draft, update } = p
  const m = useSetupModel(p)
  const card = m.card
  if (!card) return null
  const est = m.estimate.estimate
  // A tool with no listed price, or one the provider bills, has no cap worth showing.
  const cap = m.unpriced || m.ownKeySingle ? null : draft.maxCostPerRowUsd ?? est?.defaultMaxCostPerRowUsd ?? null

  return (
    <div className="p-4 space-y-3">
      <TregNotice hasKey={p.hasKey} />
      <div className="flex items-start justify-between gap-3 border border-gray-200 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">{card.title}</p>
          <p className="text-xs text-gray-500">{cardMeta(card).join(' · ')}</p>
        </div>
        <button type="button" onClick={p.onChangeTool} className="text-xs text-gray-700 underline hover:no-underline">Change</button>
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
            <label htmlFor="enrich-column-name" className="block text-sm font-medium text-gray-700 mb-1">Column name</label>
            <input id="enrich-column-name" className={`input w-full ${m.statusNameProblem ? '!border-red-300' : ''}`}
              value={draft.columnName} onChange={e => update({ columnName: e.target.value })} />
            {m.statusNameProblem
              ? <p className="text-xs text-red-600 mt-1">{m.statusNameProblem}</p>
              : <p className="text-xs text-gray-500 mt-1">Shows each row&apos;s result: found, not found, or why it failed.</p>}
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

          <AccordionSection title="Rows and limits"
            summary={`${m.rows === null ? '…' : m.rows.toLocaleString()} rows${cap !== null ? ` · up to ${formatCost(cap)}/row` : ''}`}>
            <RowsLimitsPane draft={draft} update={update} counts={m.counts} columns={p.columns}
              defaultMaxCostPerRow={est?.defaultMaxCostPerRowUsd ?? null} defaultSpendLimit={est?.estimate.highUsd ?? null}
              billedBy={m.unpriced || m.ownKeySingle ? m.ownKeyProvider : null} />
          </AccordionSection>

          <EstimateBox estimate={est} loading={m.estimate.loading} error={m.estimate.error} rows={m.rows} balance={m.data.balance}
            spendLimit={draft.spendLimitUsd} missNote={m.missNote} ownKeys={m.ownKeys} blocked={m.blocked}
            unpriced={m.unpriced} ownKeySingle={m.ownKeySingle} ownKeyProvider={m.ownKeyProvider} />
        </>
      )}

      <div className="flex flex-col items-end gap-1 pt-4 border-t border-gray-200">
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={p.onCancel} className="btn-secondary">Cancel</button>
          <button type="button" disabled className="btn-secondary">
            Run all{m.rows !== null ? ` ${m.rows.toLocaleString()}` : ''}
          </button>
          <button type="button" disabled className="btn-primary flex items-center gap-1.5">
            <Play className="h-4 w-4" />Run on {plural(Math.max(1, Math.min(ENRICH_TEST_ROWS, m.rows ?? ENRICH_TEST_ROWS)), 'row')}
          </button>
        </div>
        <p className="text-xs text-gray-500" data-testid="enrich-run-reason">{m.problem ?? 'Runs arrive in the next step.'}</p>
      </div>
    </div>
  )
}
