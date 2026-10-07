import { useEffect } from 'react'
import type { EnrichEstimateRequest } from '@/utils/api'
import { rowsFor, type EnrichDraft, type RowCounts } from './draft'
import { buildSetup } from './setup-defaults'
import { boundInputs, inputProblem } from './readiness'
import { namesProblem } from './outputs'
import { conditionsProblem } from './ConditionsField'
import { providerStates } from './ProvidersPane'
import { useSetupData } from './useSetupData'
import { useEstimate } from './useEstimate'
import { ENRICH_MAX_ROW_CAP_USD } from '@/lib/constants'

interface Args {
  sheetId: string
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  columns: string[]
  selectedCount: number
  hasKey: boolean | undefined
  active: boolean
  // Columns with a value in the rows the grid has loaded (null: unknown).
  filledColumns: Set<string> | null
}

// Everything Set up works out from the draft: the tool and sheet reads, the
// default choices (built once per tool), what still stops a run, and the
// estimate request.
export function useSetupModel({ sheetId, draft, update, columns, selectedCount, hasKey, active, filledColumns }: Args) {
  const card = draft.card
  const data = useSetupData(sheetId, card?.id ?? null, hasKey, active)
  const tool = data.tool && card && data.tool.id === card.id ? data.tool : null

  useEffect(() => {
    if (tool && card && draft.builtFor !== tool.id) update(buildSetup(card, tool, columns, filledColumns))
  }, [tool?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!tool && draft.builtFor === tool.id
  const sent = boundInputs(draft.bindings, columns)
  const counts: RowCounts = { all: data.setup?.rows.all ?? null, filter: data.setup?.rows.filter ?? null, selected: selectedCount }
  const rows = rowsFor(draft.rowsMode, counts)
  const room = data.setup ? data.setup.columns.max - data.setup.columns.count : null
  const providers = tool?.providers
    ? providerStates({ tool, access: data.access, order: draft.providerOrder, skip: draft.skipProviders, sent })
    : null
  const providersOn = providers ? providers.rows.filter(r => providers.stateOf(r) === 'on') : null

  const inputsProblem = ready && tool ? inputProblem(tool, draft.bindings, columns) : null
  const noProvider = !!providersOn && providersOn.length === 0
  const statusNameProblem = ready ? namesProblem(draft.columnName, [], columns, null) : null
  const outputNameProblem = ready && !statusNameProblem && !card?.addsRows ? namesProblem(draft.columnName, draft.outputs, columns, room) : null
  const limitsProblem = (draft.maxCostPerRowUsd ?? 0) > ENRICH_MAX_ROW_CAP_USD
    ? `Max per row can be at most $${ENRICH_MAX_ROW_CAP_USD.toLocaleString()}.` : null
  const problem = !ready ? null : inputsProblem
    ?? (noProvider ? 'No provider can run with these inputs and switches. Map more inputs or switch providers on.' : null)
    ?? limitsProblem
    ?? conditionsProblem(draft.conditions, columns)
    ?? statusNameProblem ?? outputNameProblem
    ?? (rows === 0 ? 'There are no rows to run on.' : null)

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

  // What a miss costs with what's picked, for the estimate box.
  const missNote = !tool ? '' : tool.kind === 'waterfall'
    ? (providersOn ?? []).some(r => r.billsMisses) ? 'Some providers you picked charge for a miss.' : 'You pay only when a provider finds something.'
    : tool.price.type === 'per_call' ? 'Every row is charged, found or not.'
      : tool.price.type === 'per_result' ? 'The price depends on how many results come back.'
        : tool.price.type === 'free' || tool.price.usd === 0 ? 'This tool is free.' : 'You pay only when it finds something.'

  return {
    card, tool, data, ready, sent, counts, rows, providers, providersOn, problem, statusNameProblem, outputNameProblem,
    estimate, missNote, blocked, limitsProblem, unpriced,
    ownKeys: !!providers?.rows.some(r => r.access === 'own'),
    ownKeyProvider: card?.providerName ?? card?.provider ?? 'the provider',
  }
}
