import { MAX_AI_CONCURRENCY } from '@/lib/constants'

export interface AIPreview {
  rowIndex: number
  // Server-assigned display ordinal (position in the server's sample). Render by
  // this, NOT rowIndex: the server owns the sample order and rows stream back in
  // completion order; rowIndex is only the row's identity.
  previewIndex?: number
  value: string
  error?: string
  // Actual tokens OpenRouter reported for this preview row (for run cost estimates).
  promptTokens?: number
  completionTokens?: number
  // What OpenRouter charged for the row (web fees included) and, with web
  // search, every search call and how many ran.
  costUsd?: number
  searchQueries?: Array<{ query: string; ran: boolean }>
  webSearches?: number
}

// The modal's built-in concurrency default when a sheet has no saved preference.
export const DEFAULT_CONCURRENCY = 10

// Coerce any incoming concurrency (edit-mode prefill, saved sheet default — both
// from user-writable storage) to a safe integer in [1, MAX_AI_CONCURRENCY]. A
// non-finite or out-of-range value must never reach the slider or the run.
export const clampConcurrency = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_CONCURRENCY
  return Math.max(1, Math.min(v, MAX_AI_CONCURRENCY))
}

export interface AIRun {
  id: string
  sheet_id: string
  column_name: string
  prompt: string
  system_prompt?: string
  model: string
  temperature: number
  max_chars?: number
  concurrency: number
  status: 'pending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  total_rows: number
  processed_rows: number
  created_at: string
  updated_at: string
}

export interface AIResult {
  id: string
  run_id: string
  row_index: number
  input_values: string
  output_value: string
  status: 'pending' | 'completed' | 'failed' | 'accepted' | 'rejected'
  error_message?: string
  cost_usd?: number | null
  web_searches?: number | null
  created_at: string
  updated_at: string
}

// No 'review' step: the run writes cells into rows.data live, so on completion
// there is nothing to commit — the drawer lands back on 'configure'. Mirrors
// http-modal/types.ts.
export type Step = 'configure' | 'preview' | 'run'

// No DEFAULT_MODEL: the modal starts with NO model and hydrates draft > sheet
// default > account default. When none resolves, Preview/Run stay disabled —
// an AI column only ever runs on a model the user chose.
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant for data enrichment. Use your knowledge to analyze " +
  "and enhance the provided data. Base your responses on the context from the user's data " +
  "columns. Provide clean, concise, plain text output without markdown formatting like " +
  "**bold** or *italic*. Focus on delivering accurate, relevant information that adds " +
  "value to the dataset."
