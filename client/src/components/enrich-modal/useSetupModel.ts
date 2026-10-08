import { useEffect } from 'react'
import type { EnrichEstimateRequest } from '@/utils/api'
import { effectiveMode, rowsFor, type EnrichDraft, type RowCounts } from './draft'
import { buildSetup } from './setup-defaults'
import { applyRecall } from './recall'
import { boundInputs, inputProblem } from './readiness'
import { namesProblem } from './outputs'
import { continuing, reusableNames } from './run-request'
import { conditionsProblem } from './ConditionsField'
import { providerStates } from './ProvidersPane'
import { useSetupData } from './useSetupData'
import { useEstimate } from './useEstimate'
import { countFor, useRowCounts } from './useRowCounts'
import { ENRICH_MAX_ROW_CAP_USD } from '@/lib/constants'

interface Args {
  sheetId: string
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  columns: string[]
  selectedCount: number
  selectedRows: number[]
  hasKey: boolean | undefined
  active: boolean
  // Columns with a value in the rows the grid has loaded (null: unknown).
  filledColumns: Set<string> | null
  // Changes when the rows' statuses may have (a run's phase): re-count them.
  countsKey?: string
}

// What a miss costs with what's picked, for the estimate box.
function missNoteFor(tool: ReturnType<typeof useSetupData>['tool'], anyBillsMisses: boolean): string {
  if (!tool) return ''
  if (tool.kind === 'waterfall') {
    return anyBillsMisses
      ? 'Some providers you picked charge for a miss.' : 'You pay only when a provider finds something.'
  }
  if (tool.price.type === 'per_call') return 'Every row is charged, found or not.'
  if (tool.price.type === 'per_result') return 'The price depends on how many results come back.'
  return tool.price.type === 'free' || tool.price.usd === 0
    ? 'This tool is free.' : 'You pay only when it finds something.'
}

// Everything Set up works out from the draft: the tool and sheet reads, the
// default choices (built once per tool), what still stops a run, and the
// estimate request. On a column a run already made, the rows are counted by
// their status (not enriched yet, without a result, failed, all again).
export function useSetupModel(a: Args) {
  const { sheetId, draft, update, columns, selectedCount, hasKey, active, filledColumns } = a
  const card = draft.card
  const data = useSetupData(sheetId, card?.id ?? null, hasKey, active)
  const tool = data.tool && card && data.tool.id === card.id ? data.tool : null

  // Set up's defaults for the tool, once; "Edit enrichment" lays the column's
  // own choices over them (recall.ts).
  useEffect(() => {
    if (!tool || !card || draft.builtFor === tool.id) return
    const built = buildSetup(card, tool, columns, filledColumns)
    update(draft.recall && draft.continueColumn ? applyRecall(built, draft.recall, draft.continueColumn) : built)
  }, [tool?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!tool && draft.builtFor === tool.id
  const sent = boundInputs(draft.bindings, columns)
  const counts: RowCounts = {
    all: data.setup?.rows.all ?? null, filter: data.setup?.rows.filter ?? null, selected: selectedCount,
  }
  const more = continuing(draft)
  const mode = effectiveMode(draft.rowsMode, counts)
  const byStatus = useRowCounts(sheetId, more ? draft.continueColumn : null, mode, a.selectedRows, active,
    `${draft.runId ?? ''}:${draft.runEnded}:${a.countsKey ?? ''}`)
  const rows = more ? countFor(byStatus, draft.rowsStatus) : rowsFor(draft.rowsMode, counts)
  const room = data.setup ? data.setup.columns.max - data.setup.columns.count : null
  const providers = tool?.providers
    ? providerStates({ tool, access: data.access, order: draft.providerOrder, skip: draft.skipProviders, sent })
    : null
  const providersOn = providers ? providers.rows.filter(r => providers.stateOf(r) === 'on') : null

  const inputsProblem = ready && tool ? inputProblem(tool, draft.bindings, columns) : null
  const noProvider = !!providersOn && providersOn.length === 0
  // A run that adds to the column an earlier run of this draft made may reuse its names.
  const reuse = reusableNames(draft)
  const taken = columns.filter(c => !reuse.has(c))
  const statusNameProblem = ready ? namesProblem(draft.columnName, [], taken, null) : null
  const outputNameProblem = ready && !statusNameProblem && !card?.addsRows
    ? namesProblem(draft.columnName, draft.outputs, taken, room === null ? null : room + reuse.size) : null
  const limitsProblem = (draft.maxCostPerRowUsd ?? 0) > ENRICH_MAX_ROW_CAP_USD
    ? `Max per row can be at most $${ENRICH_MAX_ROW_CAP_USD.toLocaleString()}.` : null
  const problem = !ready ? null : inputsProblem
    ?? (noProvider
      ? 'No provider can run with these inputs and switches. Map more inputs or switch providers on.' : null)
    ?? limitsProblem
    ?? conditionsProblem(draft.conditions, columns)
    ?? statusNameProblem ?? outputNameProblem
    ?? (rows === 0 ? (more ? 'No rows here match. Pick other rows to run.' : 'There are no rows to run on.') : null)

  // treg tries the team's own keys and free sources first, whatever the order.
  const pinned = (r: { access: string | null }) => r.access === 'own' || r.access === 'free'
  const order = providers
    ? [...providers.rows.filter(pinned), ...providers.rows.filter(r => !pinned(r))].map(r => r.provider)
    : draft.providerOrder
  const request: EnrichEstimateRequest | null = ready && rows !== null && tool && card ? {
    toolId: tool.id, rows, preset: card.preset ?? null, given: [...sent].sort(), skip: draft.skipProviders,
    order, stopAtFirst: draft.stopAtFirst, maxCostPerRowUsd: draft.maxCostPerRowUsd,
  } : null
  const blocked = inputsProblem || noProvider ? 'Pick the inputs above to see the cost.' : limitsProblem
  const estimate = useEstimate(blocked ? null : request)

  // A tool with no listed price runs on the team's own provider key, which
  // bills them directly (the server's priceKnown, known before any inputs).
  const unpriced = !!tool && tool.kind === 'single' && tool.price.usd === null
    && tool.price.type !== 'free' && tool.price.overflowUsd === null
  // A single tool the team runs on its own key at treg: the provider bills it,
  // not the treg balance, so treg's price says nothing about the cost.
  const ownKeySingle = !!tool && tool.kind === 'single' && !unpriced
    && (data.access?.tier === 'tool' || data.access?.tier === 'credential') && data.access?.metered !== true

  return {
    card, tool, data, ready, sent, counts, byStatus, rows, providers, providersOn, problem, statusNameProblem,
    outputNameProblem, order, estimate, blocked, limitsProblem, unpriced, ownKeySingle,
    missNote: missNoteFor(tool, (providersOn ?? []).some(r => r.billsMisses)),
    ownKeys: !!providers?.rows.some(r => r.access === 'own'),
    ownKeyProvider: card?.providerName ?? card?.provider ?? 'the provider',
  }
}
