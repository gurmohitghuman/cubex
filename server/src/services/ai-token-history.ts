// Token history behind estimate_only (run-estimate.ts).
import { db } from '../lib/db';
import {
  AI_ESTIMATE_MIN_HISTORY, AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH,
  AI_ESTIMATE_HISTORY_RUNS, AI_ESTIMATE_HISTORY_ROWS_PER_RUN,
} from '../lib/constants-ai';
import { percentile, average } from '../lib/ai-cost';
import type { Range, WebTools } from '../lib/ai-web-cost';
import { columnRuns, modelRuns, promptRuns, type WebMatch } from './ai-token-history-steps';
import { previewTokenRows } from './ai-preview-history';
import { promptHash } from '../lib/ai-prompt-hash';
import type { FetchLimits } from '../lib/web-fetch-options';

// avg as the low end, p75 as the high end.
const spread = (values: number[]): Range => {
  const low = Math.round(average(values) ?? 0);
  return { low, high: Math.max(low, Math.round(percentile(values, 75) ?? low)) };
};

const ok = (t: number | null): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0;

type Row = { p: number | null; c: number | null };

// Up to ROWS_PER_RUN finished rows of each run, through idx_ai_results_run_payer.
// The LIMIT bounds the rows read (missing token counts are dropped after it), so
// a million-row run costs the same as a ten-row one.
function finishedRows(runIds: string[]): Row[] {
  const stmt = db.prepare(`
    SELECT prompt_tokens AS p, completion_tokens AS c FROM ai_results
    WHERE run_id = ? AND status = 'completed' LIMIT ?
  `);
  return runIds.flatMap(id => stmt.all(id, AI_ESTIMATE_HISTORY_ROWS_PER_RUN) as Row[]);
}

// Where an estimate's token counts came from: this column's own runs, runs of
// the same prompt text, previews of that prompt, or every run on the model.
export type HistoryFrom = 'column' | 'prompt' | 'preview' | 'model';
// What is being estimated, so its own history is found first. column: the
// run's anchor column ("<name> (Output)", or "(Status)" with output columns).
// prompt, systemPrompt and outputs (output columns, 0 for one plain column):
// what its runs and previews are found by (lib/ai-prompt-hash.ts), the prompt
// as a start stores it.
export interface HistoryScope {
  sheetId: string; column: string | null; prompt: string; systemPrompt?: string | null; outputs?: number;
}

// Each step's rows, in the order they are preferred; read only until one has enough.
function steps(userId: string, model: string, scope: HistoryScope | null, web?: WebMatch) {
  const list: Array<[HistoryFrom, () => Row[]]> = [];
  const hash = scope ? promptHash(scope.prompt, scope.systemPrompt, scope.outputs ?? 0) : '';
  if (scope?.column) {
    const column = scope.column;
    list.push(['column', () => finishedRows(columnRuns(userId, scope.sheetId, column, model, hash, web))]);
  }
  if (scope) {
    list.push(['prompt', () => finishedRows(promptRuns(userId, model, hash, web))]);
    list.push(['preview', () => previewTokenRows(userId, model, hash, web)]);
  }
  list.push(['model', () => finishedRows(modelRuns(userId, model, web))]);
  return list;
}

// The first step with at least MIN_HISTORY known values; else the last step's (the model's) values.
function firstEnough(list: Array<[HistoryFrom, () => Row[]]>, pick: (r: Row) => number | null) {
  let values: number[] = [];
  for (const [from, read] of list) {
    values = read().map(pick).filter(ok);
    if (values.length >= AI_ESTIMATE_MIN_HISTORY) return { from, values };
  }
  return { from: null, values };
}

// Recent token history, read in bounded slices: never a sort over every result.
// Output: rows of this column's runs of the prompt, else of runs of the same
// prompt, else of previews of it, else of the latest runs on the model; each
// step needs MIN_HISTORY rows. Input of a web run: the same steps, keeping runs
// with the same web tools and web fetch limits, since what the tools read
// dominates the prompt, and engines and limits return very different amounts of
// it (engine: the one the searches run on; null matches any; no limit matches
// only runs without one). Thin history falls back to defaults (output) or the
// heuristic (web input).
export function tokenHistory(
  userId: string, model: string, web: WebTools, engine: string | null = null, scope: HistoryScope | null = null,
  fetchLimits: FetchLimits | null = null,
) {
  const out = firstEnough(steps(userId, model, scope), r => r.c);
  const output = out.from
    ? { range: spread(out.values), historyRows: out.values.length, basis: 'history' as const, from: out.from }
    : {
      range: { low: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, high: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH },
      historyRows: out.values.length, basis: 'heuristic-no-history' as const, from: null,
    };
  let webInput: Range | null = null;
  if (web.search || web.fetch) {
    const limits = web.fetch ? fetchLimits : null;
    const match: WebMatch = {
      search: web.search, fetch: web.fetch, engine: web.search ? engine : null,
      maxContentTokens: limits?.maxContentTokens ?? null, maxPages: limits?.maxPagesPerRow ?? null,
    };
    const inputs = firstEnough(steps(userId, model, scope, match), r => r.p);
    if (inputs.from) webInput = spread(inputs.values);
  }
  return { output, webInput };
}

// The run settings a search history must match: the engine that ran the
// searches, the mode sent, the per-row cap, the fetch switch and its limits.
export interface SearchSetup {
  used: string; mode: string | null; maxPerRow: number | null; fetch: boolean; fetchLimits?: FetchLimits | null;
}

// Searches per row and measured cost per row (OpenRouter's usage.cost, plus
// what the provider charged a row on the user's own key), from
// finished rows of the latest runs on this model with the same search setup.
// Each null when there's too little of it. Bounded like tokenHistory.
export function searchHistory(userId: string, model: string, s: SearchSetup): { searches: Range | null; costPerRow: Range | null } {
  const limits = s.fetch ? s.fetchLimits : null;
  const runs = (db.prepare(`
    SELECT id FROM ai_runs
    WHERE user_id = ? AND model = ? AND use_openrouter_web_search = 1 AND use_web_fetch = ?
      AND web_search_engine_used = ? AND web_search_mode IS ? AND web_search_max_per_row IS ?
      AND web_fetch_max_content_tokens IS ? AND web_fetch_max_pages IS ?
      AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = ai_runs.id AND status = 'completed')
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, model, s.fetch ? 1 : 0, s.used, s.mode, s.maxPerRow, limits?.maxContentTokens ?? null,
    limits?.maxPagesPerRow ?? null, AI_ESTIMATE_HISTORY_RUNS) as Array<{ id: string }>);
  // By run id: the runs above are the user's, and this stays a covering-index read.
  const stmt = db.prepare(`
    SELECT web_searches AS n, cost_usd + IFNULL(provider_cost_usd, 0) AS c FROM ai_results
    WHERE run_id = ? AND status = 'completed' LIMIT ?
  `);
  const rows = runs.flatMap(r => stmt.all(r.id, AI_ESTIMATE_HISTORY_ROWS_PER_RUN) as Array<{ n: number | null; c: number | null }>);
  // Unrounded: 1.4 searches a row, $0.0017 a row.
  const range = (values: number[]): Range | null => {
    if (values.length < AI_ESTIMATE_MIN_HISTORY) return null;
    const low = average(values) ?? 0;
    return { low, high: Math.max(low, percentile(values, 75) ?? low) };
  };
  return { searches: range(rows.map(r => r.n).filter(ok)), costPerRow: range(rows.map(r => r.c).filter(ok)) };
}

// Whether the latest finished row on this model ran on the user's own provider
// key through OpenRouter: its paid_with (migration 055), or on a row from
// before it, a provider_cost_usd (only set when usage.is_byok was true).
export function ranOnOwnKey(userId: string, model: string): boolean {
  const run = db.prepare(`
    SELECT id FROM ai_runs WHERE user_id = ? AND model = ?
      AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = ai_runs.id AND status = 'completed')
    ORDER BY created_at DESC LIMIT 1
  `).pluck().get(userId, model) as string | undefined;
  if (!run) return false;
  return db.prepare(`SELECT COALESCE(paid_with = 'own_key', provider_cost_usd IS NOT NULL) FROM ai_results
    WHERE run_id = ? AND status = 'completed' LIMIT 1`).pluck().get(run) === 1;
}
