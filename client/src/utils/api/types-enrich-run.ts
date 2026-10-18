// Enrichment run shapes, mirrored from server/src/lib/enrich-run-input.ts,
// lib/enrich-run-recall.ts and services/enrich-run-status.ts, enrich-rerun.ts,
// enrich-row-count.ts, enrich-column.ts and enrich-spend.ts. Re-exported from
// './types'.
import type { EnrichToolCard } from './types-enrich'
import type { EnrichDailyLimit } from './types-settings'
import type { EnrichListProgress, EnrichListRequest } from './types-enrich-list'

export type EnrichRunBinding = { column: string } | { value: string }

// Which rows: a scope, narrowed on a column a run already made by its status
// cell (empty, empty or skipped or failed, failed) or 'any' for all of them.
export type EnrichRowsScope = 'all' | 'filter' | 'selected'
// out_of_date: a result made from input cells that changed since; empty_or_out_of_date: both (the column menu).
export type EnrichRowsStatus = 'any' | 'not_enriched' | 'no_result' | 'failed' | 'out_of_date' | 'empty_or_out_of_date'

export interface EnrichRunRequest {
  toolId: string
  preset: 'verified_email' | null
  columnName: string
  // Add to an enrichment column a run already made (rows not enriched yet).
  continueColumn: boolean
  inputs: Record<string, EnrichRunBinding>
  cleanDomains: boolean
  providerOrder: string[]
  skipProviders: string[]
  stopAtFirst: boolean
  email: { accept: 'safest' | 'balanced' | 'wide'; guess: boolean; pattern: string } | null
  // fromAnswer: a field added with "+ Column" from a stored answer, kept by its path.
  outputs: Array<{ key: string; path: string | null; columnName: string; fromAnswer?: boolean }>
  rows: { mode: EnrichRowsScope; status: EnrichRowsStatus; test: boolean; rowIndexes?: number[] }
  conditions: Array<{ column: string; op: string; value: string }>
  // "Only run if" rule (absent: none).
  runIf?: string
  maxCostPerRowUsd: number | null
  spendLimitUsd: number | null
  fresh: boolean
  // The sheet's row_generation when rows were selected (a sort since: 409).
  rowGeneration?: number
  // A list job: where its results go as rows (null: outputs fill this sheet).
  list?: EnrichListRequest | null
}

// destSheetId: where a list job's rows go (a new sheet the start made).
export interface EnrichRunStarted {
  runId: string; statusColumn: string; outputColumns: string[]; destSheetId?: string | null
}

// One row's result as the grid shows it.
export interface EnrichRowResult {
  rowIndex: number
  status: string
  cells: Record<string, string>
  costUsd: number | null
  reason: string | null
  // The row's first input value, to say which row it is.
  label: string | null
}

export interface EnrichRunStatus {
  id: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  // Why the run paused itself (null: the user paused it, or it isn't paused).
  pauseReason: string | null
  message: string | null
  statusColumn: string | null
  outputColumns: string[]
  toolName: string
  preset: string | null
  // Run on 5 rows: the number of test rows (null: a full run).
  test: number | null
  totalRows: number
  processedRows: number
  skippedRows: number
  // Rows filled from a found answer an earlier run stored, at no cost.
  reusedRows: number
  rows: { completed: number; failed: number }
  spentUsd: number
  spendLimitUsd: number | null
  maxCostPerRowUsd: number | null
  dailyLimit: EnrichDailyLimit
  // The newest rows (highest row numbers first).
  latest: EnrichRowResult[]
  list?: EnrichListProgress | null
}

export interface EnrichRowCounts { total: number; notEnriched: number; noResult: number; failed: number }

// The column menu's reruns of an enrichment column.
export interface EnrichRerunRequest {
  column: string
  mode: EnrichRowsScope
  status: EnrichRowsStatus
  rowIndexes?: number[]
  rowGeneration?: number
  // The run limit the confirm quoted (else sized to the rows at start).
  spendLimitUsd?: number
  estimateOnly?: boolean
  // Call treg again instead of reusing an earlier found answer (the answer panel's "Rerun this row").
  callAgain?: boolean
}

export interface EnrichRerunEstimate {
  column: string
  toolName: string
  rows: number
  // Rows that reuse a found answer at no cost (reuseComplete false: at least that many).
  reusedRows: number
  reuseComplete: boolean
  // false: the team's own provider key bills it, so there are no figures.
  priceKnown: boolean
  lowUsd: number
  highUsd: number
  maxCostPerRowUsd: number | null
  spendLimitUsd: number | null
  dailyLimit: EnrichDailyLimit
  // A list job: the sheet its rows go to, and how many it may add.
  addsRowsTo?: { name: string; addUpTo: number } | null
}

// "Edit enrichment": what the column was set up with (its newest run).
export interface EnrichRecalledChoices {
  toolId: string
  toolName: string
  preset: 'verified_email' | null
  columnName: string
  inputs: Record<string, EnrichRunBinding>
  cleanDomains: boolean
  providerOrder: string[]
  skipProviders: string[]
  stopAtFirst: boolean
  email: { accept: 'safest' | 'balanced' | 'wide'; guess: boolean; pattern: string } | null
  // fromAnswer: a field added with "+ Column" from a stored answer, kept by its path.
  outputs: Array<{ key: string; path: string | null; columnName: string; fromAnswer?: boolean }>
  conditions: Array<{ column: string; op: string; value: string }>
  // The column's "Only run if" as one rule (older condition lists come back as one).
  runIf: string | null
  maxCostPerRowUsd: number | null
  fresh: boolean
  list?: EnrichListRequest | null
}

export interface EnrichColumnSetup {
  choices: EnrichRecalledChoices
  card: EnrichToolCard | null
  toolError: string | null
  activeRunId: string | null
  // The column's auto-run, for Set up's checkbox (null: never turned on).
  autorun: { enabled: boolean; dailyCapUsd: number | null } | null
}

export interface EnrichSpendColumn {
  sheetId: string | null
  tableName: string | null
  sheetName: string | null
  column: string | null
  spentUsd: number
  calls: number
}

export interface EnrichSpend {
  days: number
  totalUsd: number
  calls: number
  columns: EnrichSpendColumn[]
  otherUsd: number
  otherColumns: number
}

// Settings' "Stored answers" (GET /api/enrich/stored-answers).
export interface StoredAnswers {
  bytes: number | null
  answers: number | null
  countedAt: string | null
  counting: boolean
  pruneDays: number
  prune: { status: 'running' | 'done' | 'failed'; pruned: number; startedAt: string; endedAt: string | null } | null
}

// How many rows of a run would reuse a found answer an earlier run stored, at
// no cost (complete false: at least that many, counted for a while on a big
// run), and the days answers are reused for (Settings; 0: off).
export interface EnrichReuseCount {
  rows: number
  checked: number
  complete: boolean
  days: number
}
