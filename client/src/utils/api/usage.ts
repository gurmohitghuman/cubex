import { api } from './client'

// The sheet's Usage view (server routes/sheets-usage.ts, services/usage.ts):
// runs, cells run and what they cost, by column, day or run, over a range of
// UTC days. Field names match /api/v1/usage and MCP get_usage.
export type UsageGroupBy = 'column' | 'day' | 'run'
export type UsageRangeName = 'this_week' | 'this_month' | 'last_week' | 'last_month' | 'custom'
export type UsageKind = 'ai' | 'enrichment' | 'http' | 'waterfall' | 'mixed'

export interface UsageFigures {
  runs: number
  cells: number
  reused_cells: number
  ai_cost_usd: number
  provider_cost_usd: number
  enrichment_cost_usd: number
  total_cost_usd: number
  cost_per_cell_usd: number | null
}

export interface UsageRow extends UsageFigures {
  // By column and by run:
  sheet_id?: string
  sheet_name?: string | null
  sheet_deleted?: boolean
  column?: string | null
  column_deleted?: boolean
  kind?: UsageKind
  last_run_at?: string
  // By day:
  day?: string
  // By run:
  run_id?: string
  what?: string | null
  status?: string
  started_at?: string
}

export interface UsageReport {
  sheet_id: string | null
  group_by: UsageGroupBy
  range: { range: UsageRangeName; from: string; to: string }
  totals: UsageFigures
  rows: UsageRow[]
  rows_total: number
  truncated: boolean
}

// A named range, or a custom one from two days (YYYY-MM-DD).
export interface UsageAsk { groupBy: UsageGroupBy; range: UsageRangeName; from?: string; to?: string }

const params = (a: UsageAsk) => ({
  group_by: a.groupBy, ...(a.range === 'custom' ? { from: a.from, to: a.to } : { range: a.range }),
})

export const usageAPI = {
  read: (sheetId: string, a: UsageAsk, signal?: AbortSignal): Promise<UsageReport> =>
    api.get(`/sheets/${sheetId}/usage`, { params: params(a), signal, skipServerErrorToast: true })
      .then(res => res.data),

  // Every row of the range, not just the page the view shows.
  csv: (sheetId: string, a: UsageAsk): Promise<Blob> =>
    api.get(`/sheets/${sheetId}/usage/csv`, { params: params(a), responseType: 'blob', skipServerErrorToast: true })
      .then(res => res.data),
}
