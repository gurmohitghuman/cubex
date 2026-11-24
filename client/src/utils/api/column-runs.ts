import { api } from './client'
import type { WhereItem } from './views'
import type { SetupRunView } from './setups'

// Running some of a sheet's run columns again in one go (server services/column-run.ts, routes
// sheets-setups.ts). A started one is a setup run with no setup: the header's setup chip follows it.

export type RunColumnKind = 'ai' | 'http' | 'enrichment' | 'waterfall'
export const RUN_COLUMN_KIND_LABEL: Record<RunColumnKind, string> = {
  ai: 'AI', http: 'HTTP API', enrichment: 'Enrichment', waterfall: 'Waterfall',
}
export type ColumnRunMode = 'empty' | 'errored' | 'out_of_date' | 'empty_or_out_of_date' | 'all'

export interface ColumnEstimate {
  column: string; kind: RunColumnKind; layer: number; rows: number
  low_usd: number | null; high_usd: number | null; row_most_usd: number | null
  sends_requests: boolean; at_most: boolean; note: string | null
}
export interface ColumnRunEstimate {
  rows_in_scope: number; low_usd: number; high_usd: number; row_most_usd: number; unpriced: string[]
  columns: ColumnEstimate[]
  // With maxCostUsd: whether the estimate could pass it, and why.
  max_cost_usd?: number; over_ceiling?: boolean; ceiling_problem?: string | null
}
// inFilter: only the rows of the filter the sheet shows (the server reads it as the grid does).
export interface ColumnRunBody {
  columns: string[]; mode: ColumnRunMode; where?: WhereItem[]; inFilter?: boolean; estimateOnly: boolean
  maxCostUsd?: number
}

// Each caller shows the server's error in place, so the generic server-error toast stays off.
const quiet = { skipServerErrorToast: true } as const

export const columnRunsAPI = {
  columns: (sheetId: string): Promise<Array<{ column: string; kind: RunColumnKind }>> =>
    api.get(`/sheets/${sheetId}/column-runs/columns`, quiet).then(res => res.data.columns),
  run: (sheetId: string, body: ColumnRunBody, signal?: AbortSignal)
    : Promise<{ estimate: ColumnRunEstimate } | { setup_run: SetupRunView }> =>
    api.post(`/sheets/${sheetId}/column-runs`, body, { ...quiet, signal, timeout: 120_000 }).then(res => res.data),
}
