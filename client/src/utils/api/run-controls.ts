// Run controls: the column menu's numbers and runs, the header's "N failed,
// retry" and a cell's play button, for AI, HTTP API, enrichment and waterfall
// columns alike. Mirrors server/src/routes/run-controls.ts and services/run-controls*.ts.
import { api } from './client'

const noServerToast = { skipServerErrorToast: true } as const

export type RunKind = 'ai' | 'http' | 'enrichment' | 'waterfall'
// The menu's rows: empty (never run, or kept out by "Only run if") or out of
// date (a result made from input cells that changed since), every row, or the failed ones.
export type RunRows = 'empty_or_out_of_date' | 'all' | 'failed'

export interface RunCounts {
  kind: RunKind; column: string; total: number; empty: number; outOfDate: number; failed: number
}

export interface RunControlEstimate {
  kind: RunKind; column: string; rows: number
  // null: no price known (an HTTP API, a provider billing your own key, a model without a price).
  lowUsd: number | null; highUsd: number | null
  // 'range': lowUsd to highUsd; 'average_max': about lowUsd, at most highUsd (a waterfall).
  basis: 'range' | 'average_max'
  spendLimitUsd: number | null
  reusedRows: number
  note: string | null
}

export type RunControlTarget = { rows: RunRows } | { row: number; rowGeneration?: number }

export interface RunControlStarted { kind: RunKind; runId: string; rows: number }

// signal: the asker went away (a closed menu, a newer count); the server stops counting then.
export const runControlsAPI = {
  counts: (sheetId: string, column: string, signal?: AbortSignal): Promise<RunCounts> =>
    api.get(`/run-controls/sheets/${sheetId}/counts`, { params: { column }, signal, ...noServerToast })
      .then(r => r.data),

  // Failed rows per run column (only columns with some).
  failed: (sheetId: string, signal?: AbortSignal): Promise<Record<string, number>> =>
    api.get(`/run-controls/sheets/${sheetId}/failed`, { signal, ...noServerToast }).then(r => r.data.columns),

  estimate: (sheetId: string, column: string, target: RunControlTarget): Promise<RunControlEstimate> =>
    api.post(`/run-controls/sheets/${sheetId}/estimate`, { column, ...target }, noServerToast).then(r => r.data),

  start: (
    sheetId: string, column: string, target: RunControlTarget, spendLimitUsd?: number | null,
  ): Promise<RunControlStarted> =>
    api.post(`/run-controls/sheets/${sheetId}/runs`,
      { column, ...target, ...(spendLimitUsd != null ? { spendLimitUsd } : {}) }, noServerToast).then(r => r.data),
}
