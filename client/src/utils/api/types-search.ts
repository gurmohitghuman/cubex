// Web search cost controls, as the AI column drawer and the sources popup see
// them. Mirrors server/src/lib/web-search-options.ts and the shapes of
// GET /api/ai/search-plan, /ai/runs/:id and /ai/sheets/:id/sources.

export type SearchEngine = 'auto' | 'native' | 'exa' | 'parallel' | 'perplexity'

// What the drawer sends with a preview or run. mode '' and maxPerRow null: the
// engine's default mode, no cap.
export interface WebSearchSettings {
  engine: SearchEngine
  mode: string
  maxPerRow: number | null
}

export const DEFAULT_WEB_SEARCH: WebSearchSettings = { engine: 'auto', mode: '', maxPerRow: null }

// The modes of the two engines that have them, and the one each runs without a
// choice (mirrors server/src/lib/web-search-options.ts). Prices come from the
// server's search plan.
export const SEARCH_MODES: Record<'exa' | 'parallel', string[]> = {
  exa: ['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning'],
  parallel: ['turbo', 'fast', 'basic', 'advanced'],
}
export const DEFAULT_SEARCH_MODE: Record<'exa' | 'parallel', string> = { exa: 'auto', parallel: 'basic' }

// One search call of a row; ran: false when OpenRouter refused it (the cap).
export interface RowSearchQuery { query: string; ran: boolean }

// The engine a run's searches go to, priced (server webSearchSummary).
export interface SearchPlanSummary {
  engine: SearchEngine
  runs_on: 'native' | 'exa' | 'parallel' | 'perplexity'
  mode: string | null
  max_searches_per_row: number | null
  price_per_search_usd: number | null
  label: string
  note: string
}

export interface SearchPlanResponse {
  prices: {
    exa: Array<{ mode: string; price: number | null }>
    parallel: Array<{ mode: string; price: number | null }>
    perplexity: number | null
  }
  native: { available: boolean; provider: string; price: number | null; takesCap: boolean }
  plan: SearchPlanSummary | null
  error: string | null
}

// What a run has cost and searched so far (GET /ai/runs/:id).
// spent_usd (AI runs): what its spend limit counts as spent, dropped calls included.
export interface RunSpend { cost_usd: number | null; searches: number | null; spent_usd?: number }

// An AI run's spend limit as a resume sees it (GET /ai/runs/:id/spend-limit, server
// services/ai-run-limit.ts): least_usd is the lowest limit it can go on with (what it
// spent, plus what cut-off calls count, plus its next row's most); suggest_usd that
// least plus the rows left at avg_row_usd (what a row has cost so far on average, null
// before one ran); finish_usd enough to finish for sure, every row left at its most
// (null: no next row's most known). Never the run's results.
export interface AiLimitView {
  column_name: string | null; status: string; pause_reason: string | null; message: string | null
  limit_usd: number | null; spent_usd: number; cut_off_usd: number; next_row_usd: number | null
  least_usd: number; suggest_usd: number; avg_row_usd: number | null; finish_usd: number | null
  rows_left: number
}

// The search fields of a preview or run request: only with web search on (the
// server refuses them without it). '' and null mean the defaults, so they're
// left out.
export function webSearchBody(webSearchOn: boolean, s: WebSearchSettings) {
  if (!webSearchOn) return {}
  return {
    searchEngine: s.engine,
    ...(s.mode ? { searchMode: s.mode } : {}),
    ...(s.maxPerRow !== null ? { maxSearchesPerRow: s.maxPerRow } : {}),
  }
}

const ENGINES: SearchEngine[] = ['auto', 'native', 'exa', 'parallel', 'perplexity']

// Settings from a saved draft, a past run or an edit prefill (any may predate
// these fields, or carry a value this client doesn't know).
export function webSearchFrom(engine: unknown, mode: unknown, maxPerRow: unknown): WebSearchSettings {
  return {
    engine: ENGINES.includes(engine as SearchEngine) ? engine as SearchEngine : 'auto',
    mode: typeof mode === 'string' ? mode : '',
    maxPerRow: typeof maxPerRow === 'number' && maxPerRow >= 1 ? maxPerRow : null,
  }
}
