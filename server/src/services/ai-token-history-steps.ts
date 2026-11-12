// The runs an estimate's token history reads (ai-token-history.ts), newest
// first, one step at a time: this column's own runs, runs of the same prompt,
// then the model's runs. Each step is bounded: the column and prompt steps look
// at the newest AI_ESTIMATE_HISTORY_SCAN_RUNS matching runs through their own
// index (migration 055) and keep at most AI_ESTIMATE_HISTORY_RUNS that finished
// a row; the EXISTS is one index probe a run.
import { db } from '../lib/db';
import { AI_ESTIMATE_HISTORY_RUNS, AI_ESTIMATE_HISTORY_SCAN_RUNS } from '../lib/constants-ai';
import { promptHash } from '../lib/ai-prompt-hash';

// With web tools: only runs with the same tools (and, when given, searching on the same engine).
export interface WebMatch { search: boolean; fetch: boolean; engine: string | null }

const webArgs = (w: WebMatch) => [w.search ? 1 : 0, w.fetch ? 1 : 0, w.engine, w.engine];
const ids = (rows: unknown[]) => (rows as Array<{ id: string }>).map(r => r.id);

// The newest runs of this column (the run's "(Output)" or "(Status)" column) on this model.
export function columnRuns(userId: string, sheetId: string, column: string, model: string, web?: WebMatch): string[] {
  return ids(db.prepare(`
    SELECT id FROM (
      SELECT id, created_at, use_openrouter_web_search AS s, use_web_fetch AS f, web_search_engine_used AS e
      FROM ai_runs WHERE sheet_id = ? AND column_name = ? AND model = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT ?
    ) r
    WHERE (? = 0 OR (s = ? AND f = ? AND (? IS NULL OR e = ?)))
      AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = r.id AND status = 'completed')
    ORDER BY created_at DESC LIMIT ?
  `).all(sheetId, column, model, userId, AI_ESTIMATE_HISTORY_SCAN_RUNS, web ? 1 : 0,
    ...(web ? webArgs(web) : [0, 0, null, null]), AI_ESTIMATE_HISTORY_RUNS));
}

// The newest runs of this exact prompt text on this model, on any sheet.
export function promptRuns(userId: string, model: string, prompt: string, web?: WebMatch): string[] {
  return ids(db.prepare(`
    SELECT id FROM (
      SELECT id, created_at, use_openrouter_web_search AS s, use_web_fetch AS f, web_search_engine_used AS e
      FROM ai_runs WHERE user_id = ? AND model = ? AND prompt_hash = ?
      ORDER BY created_at DESC LIMIT ?
    ) r
    WHERE (? = 0 OR (s = ? AND f = ? AND (? IS NULL OR e = ?)))
      AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = r.id AND status = 'completed')
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, model, promptHash(prompt), AI_ESTIMATE_HISTORY_SCAN_RUNS, web ? 1 : 0,
    ...(web ? webArgs(web) : [0, 0, null, null]), AI_ESTIMATE_HISTORY_RUNS));
}

// The latest runs on this model (all of them, or only those with these web
// tools, searching on the same engine) that finished at least one row, so a
// string of stopped or failed test runs can't hide the history behind them.
export function modelRuns(userId: string, model: string, web?: WebMatch): string[] {
  return ids(web
    ? db.prepare(`
        SELECT id FROM ai_runs
        WHERE user_id = ? AND model = ? AND use_openrouter_web_search = ? AND use_web_fetch = ?
          AND (? IS NULL OR web_search_engine_used = ?)
          AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = ai_runs.id AND status = 'completed')
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, model, ...webArgs(web), AI_ESTIMATE_HISTORY_RUNS)
    : db.prepare(`
        SELECT id FROM ai_runs
        WHERE user_id = ? AND model = ?
          AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = ai_runs.id AND status = 'completed')
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, model, AI_ESTIMATE_HISTORY_RUNS));
}
