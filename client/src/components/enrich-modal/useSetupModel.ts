import { useEffect } from 'react'
import type { EnrichEstimateRequest } from '@/utils/api'
import { effectiveMode, rowsFor, type EnrichDraft, type RowCounts } from './draft'
import { buildSetup } from './setup-defaults'
import { applyRecall } from './recall'
import { boundInputs, inputProblem } from './readiness'
import { namesProblem } from './outputs'
import { continuing, reusableNames, runRequest } from './run-request'
import { conditionsProblem } from './ConditionsField'
import { providerStates } from './ProvidersPane'
import { useSetupData } from './useSetupData'
import { useEstimate } from './useEstimate'
import { useReuseCount, useReuseDays } from './useReuseCount'
import { countFor, useRowCounts } from './useRowCounts'
import { ENRICH_MAX_ROW_CAP_USD } from '@/lib/constants'
import { destProblem, listProblem, listProviderRows, perRowProblem, type ListDraft } from './list-draft'

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

const estimateList = (l: ListDraft) => ({
  provider: l.provider, maxItems: l.maxItems, destSheetId: l.dest.kind === 'sheet' ? l.dest.sheetId : null,
})

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
  // Read again after each start: a list job's start can add a sheet to the table.
  const data = useSetupData(sheetId, card?.id ?? null, hasKey, active, draft.runId ?? '')
  const tool = data.tool && card && data.tool.id === card.id ? data.tool : null
  // A list job's rows go to another sheet of the table: its defaults wait for the sheets.
  const addsRows = !!(tool?.addsRows ?? card?.addsRows)
  const sheets = data.setup?.sheets ?? null

  // Set up's defaults for the tool, once; "Edit enrichment" lays the column's
  // own choices over them (recall.ts).
  useEffect(() => {
    if (!tool || !card || draft.builtFor === tool.id || (addsRows && !sheets)) return
    const built = buildSetup(card, tool, columns, filledColumns, sheets ?? [])
    update(draft.recall && draft.continueColumn ? applyRecall(built, draft.recall, draft.continueColumn) : built)
  }, [tool?.id, !!sheets]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!tool && draft.builtFor === tool.id
  const sent = boundInputs(draft.bindings, columns)
  const counts: RowCounts = {
    all: data.setup?.rows.all ?? null, filter: data.setup?.rows.filter ?? null, selected: selectedCount,
  }
  const more = continuing(draft)
  const mode = effectiveMode(draft.rowsMode, counts)
  // "Only run if" narrows the rows the estimate counts (once its conditions are complete).
  const where = draft.conditions.length && !conditionsProblem(draft.conditions, columns) ? draft.conditions : []
  const ruled = !!draft.runIf.trim()
  const byStatus = useRowCounts(sheetId, more ? draft.continueColumn : null, mode, a.selectedRows, active,
    `${draft.runId ?? ''}:${draft.runEnded}:${a.countsKey ?? ''}`, where, draft.runIf)
  const rows = more ? countFor(byStatus, draft.rowsStatus)
    : where.length || ruled ? byStatus?.total ?? null : rowsFor(draft.rowsMode, counts)
  const room = data.setup ? data.setup.columns.max - data.setup.columns.count : null
  // A list job asks one provider (its own pick), so the waterfall's provider list isn't shown.
  const list = draft.list
  const providers = tool?.providers && !list
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
  const listTest = ready && list && tool ? listProblem(list, tool, sent, sheets, true) : null
  const problem = !ready ? null : inputsProblem
    ?? listTest
    ?? (noProvider
      ? 'No provider can run with these inputs and switches. Map more inputs or switch providers on.' : null)
    ?? limitsProblem
    ?? conditionsProblem(draft.conditions, columns)
    ?? statusNameProblem ?? outputNameProblem
    ?? (rows !== 0 ? null
      : more || where.length || ruled ? 'No rows here match. Pick other rows to run.' : 'There are no rows to run on.')

  // treg tries the team's own keys and free sources first, whatever the order.
  const pinned = (r: { access: string | null }) => r.access === 'own' || r.access === 'free'
  const order = providers
    ? [...providers.rows.filter(pinned), ...providers.rows.filter(r => !pinned(r))].map(r => r.provider)
    : draft.providerOrder
  // Rows that reuse an earlier found answer cost nothing: the estimate prices the others.
  const reuseAsk = ready && card && !problem && rows
    ? runRequest(draft, { mode, selectedRows: a.selectedRows, test: false, order }) : null
  const reuseCount = useReuseCount(sheetId, reuseAsk)
  const reuseDays = useReuseDays(active)
  const priced = rows === null ? null : Math.max(0, rows - (reuseCount?.rows ?? 0))
  const request: EnrichEstimateRequest | null = ready && priced !== null && tool && card ? {
    toolId: tool.id, rows: priced, preset: card.preset ?? null, given: [...sent].sort(), skip: draft.skipProviders,
    order, stopAtFirst: draft.stopAtFirst, maxCostPerRowUsd: draft.maxCostPerRowUsd,
    ...(list ? { list: estimateList(list) } : {}),
  } : null
  const listCost = !list ? null
    : (tool ? perRowProblem(list.maxItems, tool) : null)
      ?? (tool?.kind === 'waterfall' && !list.provider ? 'Pick a provider to see the cost.' : null)
  // No rows to run (none pass "Only run if", or none fit the status): nothing to price.
  const noRows = ready && rows === 0 ? 'No rows here match, so there is nothing to estimate.' : null
  const blocked = inputsProblem || noProvider ? 'Pick the inputs above to see the cost.'
    : noRows ?? limitsProblem ?? listCost
  const estimate = useEstimate(blocked ? null : request)

  // A tool with no listed price runs on the team's own provider key, which
  // bills them directly (the server's priceKnown, known before any inputs).
  const unpriced = !!tool && tool.kind === 'single' && tool.price.usd === null
    && tool.price.type !== 'free' && tool.price.overflowUsd === null
  // A single tool the team runs on its own key at treg: the provider bills it,
  // not the treg balance, so treg's price says nothing about the cost.
  const ownKeySingle = !!tool && tool.kind === 'single' && !unpriced
    && (data.access?.tier === 'tool' || data.access?.tier === 'credential') && data.access?.metered !== true

  // A list job's provider bills a miss or not (its row in treg's plan).
  const listBills = !!list && !!tool && listProviderRows(tool, sent)
    .some(r => r.provider.toLowerCase() === list.provider?.toLowerCase() && r.billsMisses)
  return {
    card, tool, data, ready, sent, counts, byStatus, rows, reuse: reuseCount, reuseDays, providers, providersOn,
    problem, statusNameProblem,
    outputNameProblem, order, estimate, blocked, limitsProblem, unpriced, ownKeySingle, sheets,
    // A list job's defaults need the table's sheets: their read failed.
    listSheetsError: addsRows && !sheets && data.setupError,
    // A list job: its destination's problem (shown in place) and what stops a full run (fields not picked).
    listDest: list ? destProblem(list, sheets) : null,
    listDestName: !list ? null : list.dest.kind === 'new' ? list.dest.name.trim()
      : sheets?.find(s => s.id === (list.dest as { sheetId: string }).sheetId)?.name ?? null,
    fullProblem: ready && list && tool ? listProblem(list, tool, sent, sheets, false) : null,
    updateList: (patch: Partial<ListDraft>) => { if (draft.list) update({ list: { ...draft.list, ...patch } }) },
    missNote: list && tool?.kind === 'waterfall'
      ? (listBills ? 'This provider charges for a miss too.' : 'You pay only when it finds results.')
      : missNoteFor(tool, (providersOn ?? []).some(r => r.billsMisses)),
    ownKeys: !!providers?.rows.some(r => r.access === 'own'),
    ownKeyProvider: card?.providerName ?? card?.provider ?? 'the provider',
  }
}
