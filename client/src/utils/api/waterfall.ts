// Waterfall columns: the start request, its estimate, a column's setup, a run's
// status and a cell's trace. Mirrors server/src/lib/waterfall/input.ts and
// services/waterfall-{estimate,column,status,trace}.ts.
import { api } from './client'

const noServerToast = { skipServerErrorToast: true } as const

export type ResultType = 'email' | 'phone' | 'domain' | 'linkedin_url' | 'url' | 'text'
export type StepKind = 'enrichment' | 'ai' | 'http' | 'formula'
export type RowsStatus = 'any' | 'not_enriched' | 'no_result' | 'failed'
export type InputSource = { column: string } | { value: string }

export interface EnrichmentChoices {
  kind: 'enrichment'; toolId: string; inputs: Record<string, string | { value: string }>;
  providerOrder: string[]; skipProviders: string[]; stopAtFirst: boolean; valuePath: string | null;
  maxCostUsd: number | null
}
export interface AiChoices { kind: 'ai'; prompt: string; model: string | null; webSearch: boolean }
export interface HttpChoices {
  kind: 'http'; method: string; url: string; headers: Record<string, string>; body: string | null; valuePath: string;
  retries: number | null
}
export interface FormulaChoices { kind: 'formula'; formula: string }
export type StepChoices = EnrichmentChoices | AiChoices | HttpChoices | FormulaChoices
export type EmailAccept = 'safest' | 'balanced' | 'wide'
// A check on the value a step finds: treg's email verify, or a formula over {{value}} (truthy passes).
export type CheckChoices = { kind: 'verify'; accept: EmailAccept } | { kind: 'formula'; formula: string }

export interface StepInput {
  id: string | null; label: string | null; on: boolean; requires: string[][] | null; choices: StepChoices
  check?: CheckChoices | null
}

export interface WaterfallRunInput {
  columnName: string
  continueColumn: boolean
  resultType: ResultType
  phone: { format: 'national' | 'international' | 'e164'; country: string } | null
  inputs: Array<{ key: string; label: string; source: InputSource | null }>
  steps: StepInput[]
  answeredBy: boolean
  hideStepColumns: boolean
  rows: { mode: 'all' | 'filter' | 'selected'; status: RowsStatus; test: number | null; rowIndexes: number[] | null }
  runIf: string | null
  spendLimitUsd: number | null
  concurrency: number | null
  fresh: boolean
  noReuse?: boolean
  rowGeneration: number | null
  dry?: { rowIds: string[] | null; only: string | null } | null   // a dry run: writes nothing to the sheet
}

export interface StepEstimate {
  id: string; label: string; kind: StepKind; on: boolean
  reach: number | null; max_usd: number; expected_usd: number
  answer_rate: number | null; rate_from: 'history' | 'treg' | null
}

export interface WaterfallEstimate {
  result_type: string
  rows: number
  per_row: { average_usd: number; max_usd: number }
  total: { average_usd: number; max_usd: number }
  run_limit_usd: number | null
  steps: StepEstimate[]
  daily_limit: { limitUsd: number | null; usedTodayUsd: number; remainingUsd: number | null } | null
  notes: string[]
}

export interface WaterfallSetup {
  input: WaterfallRunInput
  columns: { answeredBy: string | null; steps: Record<string, string> }
  activeRunId: string | null
  autoRun: boolean
  toolNames: Record<string, string>
}

export interface WaterfallStarted { runId: string; resultColumn: string; outputColumns: string[]; rowsInScope: number }

export interface WaterfallStepStatus {
  id: string; label: string; kind: StepKind; on: boolean
  reached: number; answered: number; rejected: number; failed: number; skipped: number; cost_usd: number
}

export interface WaterfallRunStatus {
  id: string; sheet_id: string; status: string; message: string | null; pause_reason: string | null
  starting: boolean; processed_rows: number; total_rows: number; skipped_rows: number
  condition_skipped_rows: number; result_column: string | null; answered_by_column: string | null
  result_type: string; dry: boolean; auto_run: boolean
  spent: { treg_usd: number; ai_usd: number; total_usd: number }; run_limit_usd: number | null
  max_per_row_usd: number
  steps: WaterfallStepStatus[]
}

export type StepOutcome = 'answered' | 'rejected' | 'not_found' | 'no_inputs' | 'error' | 'budget'

export interface TraceStepView {
  id: string; label: string; kind: StepKind; on: boolean; reached: boolean
  outcome?: StepOutcome; value?: string; detail?: string; provider?: string
  cost_usd?: number; ms?: number; from?: 'journal' | 'dry_run' | 'reused' | 'same_lookup' | 'last_run'
  check?: CheckOutcome
}
export interface CheckOutcome {
  outcome: 'passed' | 'failed' | 'error'; verdict?: string; cost_usd: number; from?: TraceStepView['from']
}

export interface WaterfallTrace {
  column: string; resultColumn: string; rowIndex: number; runId: string; runAt: string
  status: 'completed' | 'failed'; reason: string | null; resultType: string
  value: string; answeredBy: string | null; costUsd: number | null
  steps: TraceStepView[]
}

// A dry run as the drawer shows it: each row's inputs and the steps it reached.
export interface TraceStep {
  id: string; label: string; kind: StepKind; outcome: StepOutcome; value?: string; detail?: string
  provider?: string; cost_usd: number; ms: number; from?: TraceStepView['from']; check?: CheckOutcome
}
export interface DryRow {
  row_index: number; row_id: string | null; inputs: Record<string, string>; done: boolean; gone: boolean
  value: string; answered_by: string | null; cost_usd: number | null; steps: TraceStep[]
}
export interface DryRunView {
  run: WaterfallRunStatus; column: string; only: { id: string; label: string } | null
  steps: Array<{ id: string; label: string; kind: StepKind }>; rows: DryRow[]
}

export interface WaterfallRerunRequest {
  column: string; status: RowsStatus; rowIndexes?: number[]; rowGeneration?: number; spendLimitUsd?: number
  noReuse?: boolean   // this run asks every step afresh ("Run this row again")
}

export const waterfallAPI = {
  estimate: (sheetId: string, body: WaterfallRunInput, signal?: AbortSignal): Promise<WaterfallEstimate> =>
    api.post(`/waterfall/sheets/${sheetId}/estimate`, body, { ...noServerToast, signal }).then(res => res.data),

  start: (sheetId: string, body: WaterfallRunInput): Promise<WaterfallStarted> =>
    api.post(`/waterfall/sheets/${sheetId}/runs`, body, noServerToast).then(res => res.data),

  columnSetup: (sheetId: string, column: string): Promise<WaterfallSetup> =>
    api.get(`/waterfall/sheets/${sheetId}/column-setup`, { ...noServerToast, params: { column } })
      .then(res => res.data),

  rerunEstimate: (sheetId: string, body: WaterfallRerunRequest): Promise<WaterfallEstimate> =>
    api.post(`/waterfall/sheets/${sheetId}/reruns`, { ...body, estimateOnly: true }, noServerToast)
      .then(res => res.data.estimate),

  rerun: (sheetId: string, body: WaterfallRerunRequest): Promise<WaterfallStarted> =>
    api.post(`/waterfall/sheets/${sheetId}/reruns`, body, noServerToast).then(res => res.data.started),

  runStatus: (runId: string): Promise<WaterfallRunStatus> =>
    api.get(`/waterfall/runs/${runId}`, noServerToast).then(res => res.data),

  // Resume a paused run, with a higher run limit when given.
  resume: (runId: string, spendLimitUsd?: number): Promise<WaterfallRunStatus> =>
    api.post(`/waterfall/runs/${runId}/resume`, spendLimitUsd === undefined ? {} : { spendLimitUsd }, noServerToast)
      .then(res => res.data),

  startDryRun: (sheetId: string, body: WaterfallRunInput): Promise<{ runId: string; rowIndexes: number[] }> =>
    api.post(`/waterfall/sheets/${sheetId}/dry-runs`, body, noServerToast).then(res => res.data),

  dryRun: (runId: string): Promise<DryRunView> =>
    api.get(`/waterfall/dry-runs/${runId}`, noServerToast).then(res => res.data),

  trace: (sheetId: string, column: string, row: number): Promise<WaterfallTrace> =>
    api.get(`/waterfall/sheets/${sheetId}/trace`, { ...noServerToast, params: { column, row } }).then(res => res.data),
}
