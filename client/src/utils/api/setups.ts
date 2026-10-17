import { api } from './client'

// Setups (server routes/setups.ts, sheets-setups.ts; services/setup-*.ts): a
// saved copy of a chain of filled columns, to build them again on another sheet.

export type SetupKind = 'ai' | 'http' | 'enrichment' | 'clean' | 'formula'

export const SETUP_KIND_LABEL: Record<SetupKind, string> = {
  ai: 'AI', http: 'HTTP API', enrichment: 'Enrichment', clean: 'Clean data', formula: 'Formula',
}

export interface SetupStepSummary { kind: SetupKind; kind_label: string; column: string; columns: string[] }

export interface SetupSummary {
  id: string
  name: string
  description: string | null
  // Columns the setup reads that none of its steps make: the sheet it's used on needs them.
  inputs: string[]
  // Saved keys its requests name (names only).
  keys: string[]
  steps: SetupStepSummary[]
  use_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

// A filled column of a sheet as a step: what it reads, or why it can't be saved.
export interface SheetSetupStep {
  kind: SetupKind
  column: string
  columns: string[]
  reads: string[]
  problem: string | null
}

// What a setup of some columns would hold: its steps in order, inputs and keys.
export interface SetupPlan {
  inputs: string[]
  keys: string[]
  steps: SetupStepSummary[]
}

export interface SetupFileDownload { file: unknown; filename: string }

// A setup in full: each step as saved (the dialog reads an AI step's model).
export interface SetupDetail extends SetupSummary {
  spec: { inputs: string[]; keys: string[]; steps: Array<{ kind: SetupKind; name: string; model?: string | null }> }
}

export interface ApplyBody {
  inputs?: Record<string, string>
  names?: Record<string, string>
  models?: Record<string, string>
  firstRows?: number | null
  estimateOnly: boolean
}

// A step makes its columns ('new'), or carries a column the sheet has on ('again': only the rows it hasn't done).
export type SetupStepMode = 'new' | 'again'

// What one step could cost: dollars (null when free, an HTTP API's own bill, or no price), and why not.
export interface StepEstimate {
  column: string; kind: SetupKind; layer: number; mode: SetupStepMode; rows: number
  low_usd: number | null; high_usd: number | null; sends_requests: boolean; free: boolean; note: string | null
}
export interface SetupEstimate {
  rows: number; low_usd: number; high_usd: number; unpriced: string[]; steps: StepEstimate[]
}

export type SetupRunStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
export interface SetupRunView {
  id: string; setup_id: string | null; setup_name: string; sheet_id: string; status: SetupRunStatus
  layer: number; layers: number; test_rows: number | null; error_message: string | null
  created_at: string; updated_at: string
  // What it was used with: using the setup again on the sheet starts from them.
  choices: {
    inputs?: Record<string, string>; names?: Record<string, string>; models?: Record<string, string>
  } | null
  steps: Array<{
    column: string; kind: SetupKind; layer: number; mode: SetupStepMode; state: string; run_id: string | null
    note: string | null
  }>
}

// Each caller shows the server's error in place, so the generic server-error toast stays off.
const quiet = { skipServerErrorToast: true } as const

export const setupsAPI = {
  list: (): Promise<SetupSummary[]> => api.get('/setups', quiet).then(res => res.data.setups),
  update: (id: string, body: { name?: string; description?: string }): Promise<SetupSummary> =>
    api.patch(`/setups/${id}`, body, quiet).then(res => res.data),
  remove: (id: string): Promise<void> => api.delete(`/setups/${id}`, quiet).then(() => {}),
  exportFile: (id: string): Promise<SetupFileDownload> => api.get(`/setups/${id}/export`, quiet).then(res => res.data),
  importFile: (file: unknown): Promise<SetupSummary> => api.post('/setups/import', file, quiet).then(res => res.data),

  get: (id: string): Promise<SetupDetail> => api.get(`/setups/${id}`, quiet).then(res => res.data),
  apply: (sheetId: string, setupId: string, body: ApplyBody, signal?: AbortSignal)
    : Promise<{ estimate: SetupEstimate; carries_on: string[] } | { setup_run: SetupRunView }> =>
    api.post(`/sheets/${sheetId}/setups/${setupId}/apply`, body, { ...quiet, signal, timeout: 120_000 })
      .then(res => res.data),
  // setupId: only that setup's runs on the sheet.
  runs: (sheetId: string, setupId?: string): Promise<SetupRunView[]> =>
    api.get(`/sheets/${sheetId}/setup-runs`, { ...quiet, params: setupId ? { setupId } : undefined })
      .then(res => res.data.setup_runs),
  control: (id: string, action: 'pause' | 'resume' | 'cancel'): Promise<SetupRunView> =>
    api.post(`/setup-runs/${id}/${action}`, null, quiet).then(res => res.data),

  sheetSteps: (sheetId: string): Promise<SheetSetupStep[]> =>
    api.get(`/sheets/${sheetId}/setup-steps`, quiet).then(res => res.data.steps),
  plan: (sheetId: string, columns: string[], signal?: AbortSignal): Promise<SetupPlan> =>
    api.post(`/sheets/${sheetId}/setups/plan`, { columns, includeUpstream: false }, { ...quiet, signal })
      .then(res => res.data),
  save: (sheetId: string, body: { name: string; description: string; columns: string[] }): Promise<SetupSummary> =>
    api.post(`/sheets/${sheetId}/setups`, { ...body, includeUpstream: false }, quiet).then(res => res.data),
}
