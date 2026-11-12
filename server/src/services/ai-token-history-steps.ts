// The runs an estimate's token history reads (ai-token-history.ts), newest
// first, one step at a time: this column's own runs of the prompt, runs of the
// same prompt, then the model's runs. Each step is bounded: the column and
// prompt steps look at the newest AI_ESTIMATE_HISTORY_SCAN_RUNS matching runs
// through their own index (migration 055) and keep at most
// AI_ESTIMATE_HISTORY_RUNS that finished a row; the EXISTS is one index probe a run.
import { db } from '../lib/db';
import { AI_ESTIMATE_HISTORY_RUNS, AI_ESTIMATE_HISTORY_SCAN_RUNS } from '../lib/constants-ai';

// With web tools: only runs with the same tools and the same web fetch limits (null: no limit, a value of its
// own), and, when given, searching on the same engine.
export interface WebMatch {
  search: boolean; fetch: boolean; engine: string | null; maxContentTokens: number | null; maxPages: number | null;
}

const webArgs = (w: WebMatch) =>
  [w.search ? 1 : 0, w.fetch ? 1 : 0, w.engine, w.engine, w.maxContentTokens, w.maxPages];
const NO_WEB = [0, 0, null, null, null, null];
const ids = (rows: unknown[]) => (rows as Array<{ id: string }>).map(r => r.id);

// The newest runs of this column (the run's "(Output)" or "(Status)" column) on this model, of this prompt (its
// hash: lib/ai-prompt-hash.ts) or of one stored before prompts were hashed: an edited prompt isn't sized by the
// old one's rows. Written out in full (no shared fragments), so the SQL schema test checks each statement.
export function columnRuns(
  userId: string, sheetId: string, column: string, model: string, hash: string, web?: WebMatch,
): string[] {
  return ids(db.prepare(`
    SELECT id FROM (
      SELECT id, created_at, prompt_hash AS h, use_openrouter_web_search AS s, use_web_fetch AS f,
        web_search_engine_used AS e, web_fetch_max_content_tokens AS t, web_fetch_max_pages AS pg
      FROM ai_runs WHERE sheet_id = ? AND column_name = ? AND model = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT ?
    ) r
    WHERE (h = ? OR h IS NULL) AND (? = 0 OR (s = ? AND f = ? AND (? IS NULL OR e = ?) AND t IS ? AND pg IS ?))
      AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = r.id AND status = 'completed')
    ORDER BY created_at DESC LIMIT ?
  `).all(sheetId, column, model, userId, AI_ESTIMATE_HISTORY_SCAN_RUNS, hash, web ? 1 : 0,
    ...(web ? webArgs(web) : NO_WEB), AI_ESTIMATE_HISTORY_RUNS));
}

// The newest runs of this exact prompt (its hash) on this model, on any sheet.
export function promptRuns(userId: string, model: string, hash: string, web?: WebMatch): string[] {
  return ids(db.prepare(`
    SELECT id FROM (
      SELECT id, created_at, use_openrouter_web_search AS s, use_web_fetch AS f, web_search_engine_used AS e,
        web_fetch_max_content_tokens AS t, web_fetch_max_pages AS pg
      FROM ai_runs WHERE user_id = ? AND model = ? AND prompt_hash = ?
      ORDER BY created_at DESC LIMIT ?
    ) r
    WHERE (? = 0 OR (s = ? AND f = ? AND (? IS NULL OR e = ?) AND t IS ? AND pg IS ?))
      AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = r.id AND status = 'completed')
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, model, hash, AI_ESTIMATE_HISTORY_SCAN_RUNS, web ? 1 : 0,
    ...(web ? webArgs(web) : NO_WEB), AI_ESTIMATE_HISTORY_RUNS));
}

// The latest runs on this model (all of them, or only those with these web
// tools and fetch limits, searching on the same engine) that finished at least
// one row, so a string of stopped or failed test runs can't hide the history behind them.
export function modelRuns(userId: string, model: string, web?: WebMatch): string[] {
  return ids(web
    ? db.prepare(`
        SELECT id FROM ai_runs
        WHERE user_id = ? AND model = ? AND use_openrouter_web_search = ? AND use_web_fetch = ?
          AND (? IS NULL OR web_search_engine_used = ?)
          AND web_fetch_max_content_tokens IS ? AND web_fetch_max_pages IS ?
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
