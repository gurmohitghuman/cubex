// Token history behind estimate_only (run-estimate.ts).
import { db } from '../lib/db';
import {
  AI_ESTIMATE_MIN_HISTORY, AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH,
  AI_ESTIMATE_HISTORY_RUNS, AI_ESTIMATE_HISTORY_ROWS_PER_RUN,
} from '../lib/constants-ai';
import { percentile, average } from '../lib/ai-cost';
import type { Range, WebTools } from '../lib/ai-web-cost';

// avg as the low end, p75 as the high end (Clay's withholding rank).
const spread = (values: number[]): Range => {
  const low = Math.round(average(values) ?? 0);
  return { low, high: Math.max(low, Math.round(percentile(values, 75) ?? low)) };
};

const ok = (t: number | null): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0;

// The latest runs on this model (all of them, or only those with these web
// tools) that finished at least one row, so a string of stopped or failed test
// runs can't hide the history behind them. The EXISTS is one index probe a run.
function latestRuns(userId: string, model: string, web?: WebTools): string[] {
  const rows = web
    ? db.prepare(`
        SELECT id FROM ai_runs
        WHERE user_id = ? AND model = ? AND use_openrouter_web_search = ? AND use_web_fetch = ?
          AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = ai_runs.id AND status = 'completed')
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, model, web.search ? 1 : 0, web.fetch ? 1 : 0, AI_ESTIMATE_HISTORY_RUNS)
    : db.prepare(`
        SELECT id FROM ai_runs
        WHERE user_id = ? AND model = ?
          AND EXISTS (SELECT 1 FROM ai_results WHERE run_id = ai_runs.id AND status = 'completed')
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, model, AI_ESTIMATE_HISTORY_RUNS);
  return (rows as Array<{ id: string }>).map(r => r.id);
}

// Up to ROWS_PER_RUN finished rows of each run, through idx_ai_results_run_status.
// The LIMIT bounds the rows read (missing token counts are dropped after it), so
// a million-row run costs the same as a ten-row one.
function finishedRows(runIds: string[]): Array<{ p: number | null; c: number | null }> {
  const stmt = db.prepare(`
    SELECT prompt_tokens AS p, completion_tokens AS c FROM ai_results
    WHERE run_id = ? AND status = 'completed' LIMIT ?
  `);
  return runIds.flatMap(id => stmt.all(id, AI_ESTIMATE_HISTORY_ROWS_PER_RUN) as Array<{ p: number | null; c: number | null }>);
}

// Recent token history for THIS model across the user's runs, read in bounded
// slices: never a sort over every result. Output: rows of the latest runs.
// Input of a web run: rows of the latest runs with the same web tools, since
// what the tools read dominates the prompt. Thin history (< MIN_HISTORY) falls
// back to defaults (output) or the heuristic (web input).
export function tokenHistory(userId: string, model: string, web: WebTools) {
  const outputs = finishedRows(latestRuns(userId, model)).map(r => r.c).filter(ok);
  const output = outputs.length >= AI_ESTIMATE_MIN_HISTORY
    ? { range: spread(outputs), historyRows: outputs.length, basis: 'history' as const }
    : {
      range: { low: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, high: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH },
      historyRows: outputs.length, basis: 'heuristic-no-history' as const,
    };
  let webInput: Range | null = null;
  if (web.search || web.fetch) {
    const inputs = finishedRows(latestRuns(userId, model, web)).map(r => r.p).filter(ok);
    if (inputs.length >= AI_ESTIMATE_MIN_HISTORY) webInput = spread(inputs);
  }
  return { output, webInput };
}
