export interface Table {
  id: string
  name: string
  created_at: string
  updated_at: string
  row_count: number
  sheets?: Sheet[]
  // Tab-list fingerprint from GET /tables/:id; seeds the change-poll's tab check.
  sheets_key?: string | null
}

export interface Sheet {
  id: string
  table_id: string
  name: string
  position: number
  created_at: string
  updated_at: string
  sort_state?: string | null
  empty_filter?: string | null
  column_filters?: string | null
  default_ai_model?: string | null
  default_ai_concurrency?: number | null
  // Optimistic-concurrency token for row_index meaning (server migration 021).
  // Echoed back on cell-edit / bulk-delete writes; a mismatch ⇒ 409 (the sheet
  // was sorted / replace-imported elsewhere) and the client reloads.
  row_generation?: number
  // Live-update signal (webhook appends + /api/v1 mutations bump it). Seeds the
  // change poll so a write landing between the sheet GET and the first poll
  // still triggers a reload.
  data_version?: number
}

// Authoritative per-column type, server-derived from run records (NOT guessed
// from cell contents). Columns absent from columnTypes are plain. Keep the union
// in sync with server lib/column-types.ts.
export type ColumnType =
  | 'ai-output' | 'ai-data' | 'http-master' | 'http-extracted'
  | 'webhook-source' | 'webhook-mapped'

export interface SheetData {
  sheet: Sheet
  data: {
    rows: Array<{ rowIndex: number; data: Record<string, string> }>
    columns: string[]
    totalRows: number
    columnTypes?: Record<string, ColumnType>
  }
}

export interface AIRun {
  id: string
  sheet_id: string
  column_name: string
  prompt: string
  system_prompt?: string
  model: string
  temperature: number
  use_openrouter_web_search?: boolean
  use_web_fetch?: boolean
  max_chars?: number
  concurrency: number
  // Structured runs (several typed columns from one call per row): the typed
  // columns' spec (JSON), the "(Status)" column and the "(Data)" column.
  output_columns?: string | null
  status_column?: string | null
  data_column?: string | null
  // Web search engine sent, engine that ran the searches, mode and per-row cap.
  web_search_engine?: string | null
  web_search_engine_used?: string | null
  web_search_mode?: string | null
  web_search_max_per_row?: number | null
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
  scraped_data?: string
  // What the row cost (OpenRouter's usage.cost), the searches that ran, and
  // every search call as JSON [{query, ran}]; null when not recorded.
  cost_usd?: number | null
  web_searches?: number | null
  web_search_queries?: string | null
  created_at: string
  updated_at: string
}

// A persisted AI Column draft (GET /ai/drafts/:sheetId). Written server-side by
// /ai/preview; previewResults is null when no COMPLETE preview exists or the
// sheet's row order changed since (stale rowIndex values must not be shown).
export interface AIDraft {
  config: {
    columnName: string
    prompt: string
    systemPrompt: string | null
    model: string
    temperature: number
    useOpenRouterWebSearch: boolean
    useWebFetch: boolean
    maxChars: number | null
    concurrency: number
    searchEngine?: string | null
    searchMode?: string | null
    maxSearchesPerRow?: number | null
  }
  previewResults: Array<{
    rowIndex: number
    value: string
    error?: string
    promptTokens?: number
    completionTokens?: number
    costUsd?: number
    searchQueries?: Array<{ query: string; ran: boolean }>
    webSearches?: number
  }> | null
  runTargetRows: number | null
}

export interface AIPreview {
  rowIndex: number
  // Server-assigned display ordinal (position in the server's sample). Render by
  // this, not rowIndex — see the mirror in components/ai-modal/types.ts.
  previewIndex?: number
  value: string
  error?: string
  // Actual tokens OpenRouter reported for this preview row (for run cost estimates).
  promptTokens?: number
  completionTokens?: number
  // What OpenRouter charged for the row, web fees included, and its searches.
  costUsd?: number
  searchQueries?: Array<{ query: string; ran: boolean }>
  webSearches?: number
}

export interface HTTPRun {
  id: string
  sheet_id: string
  config: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  total_rows: number
  processed_rows: number
  master_column_name?: string
  created_at: string
  updated_at: string
}

export interface HTTPResult {
  id: string
  run_id: string
  row_index: number
  request_config: string
  response_data: string | null
  extracted_fields: string
  status: 'pending' | 'completed' | 'failed'
  error_message?: string
  created_at: string
  updated_at: string
}

export interface HTTPPreview {
  rowIndex: number
  status: 'success' | 'error' | 'skipped'
  extractedFields: Record<string, any>
  requestSummary?: { method: string; url: string }
  error?: string
  reason?: string
}

export interface HTTPColumnAssociation {
  id: string
  sheet_id: string
  master_column_name: string
  extracted_column_name: string
  run_id: string
  created_at: string
}

export * from './types-settings'
