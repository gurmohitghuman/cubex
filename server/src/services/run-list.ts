// List a user's recent runs. Neither /api/v1 nor MCP could enumerate runs —
// only fetch one by id — so after a failed or interrupted start the run_id was
// simply GONE and there was no way back to it.
// That turns a recoverable situation into "start over".
//
// Returns the same RunSummary shape as get{Ai,Http}RunSummary so a caller can
// hand any element straight to get_run_status / get_run_results / control_run.
import { db } from '../lib/db';
import { RunSummary, aiRunSummaryFromRow, httpRunSummaryFromRow } from './run-status';

export type RunListFilter = 'active' | 'terminal' | 'all';

const ACTIVE_STATUSES = ['pending', 'running', 'paused'] as const;

// Bounded so a long-lived account can't return thousands of rows into an
// agent's context. Callers wanting more should filter by sheet.
export const RUN_LIST_MAX = 50;
export const RUN_LIST_DEFAULT = 20;

function statusPredicate(filter: RunListFilter): { sql: string; params: string[] } {
  if (filter === 'all') return { sql: '', params: [] };
  const marks = ACTIVE_STATUSES.map(() => '?').join(',');
  // 'terminal' is the complement of active, expressed as NOT IN rather than an
  // explicit list so a newly-added non-terminal status can't silently start
  // showing up as "terminal".
  return filter === 'active'
    ? { sql: `AND status IN (${marks})`, params: [...ACTIVE_STATUSES] }
    : { sql: `AND status NOT IN (${marks})`, params: [...ACTIVE_STATUSES] };
}

// Most-recent-first across BOTH run kinds. Ordering happens after the union in
// JS: the two tables have independent created_at values and no shared cursor,
// and the result set is capped at RUN_LIST_MAX, so a SQL UNION + ORDER BY would
// add complexity for no benefit at this size.
export function listRuns(
  userId: string,
  opts: { sheetId?: string; filter?: RunListFilter; limit?: number } = {},
): RunSummary[] {
  const filter = opts.filter ?? 'all';
  const limit = Math.max(1, Math.min(opts.limit ?? RUN_LIST_DEFAULT, RUN_LIST_MAX));
  const p = statusPredicate(filter);
  const sheetSql = opts.sheetId ? 'AND sheet_id = ?' : '';
  const sheetParams = opts.sheetId ? [opts.sheetId] : [];

  const aiRows = db.prepare(`
    SELECT id, sheet_id, column_name, model, concurrency, status, processed_rows, total_rows, error_message,
           target_rows, created_at, updated_at, output_columns, data_column, use_openrouter_web_search,
           web_search_engine, web_search_engine_used, web_search_mode, web_search_max_per_row,
           run_if, condition_skipped_rows
    FROM ai_runs WHERE user_id = ? AND setup_only = 0 ${sheetSql} ${p.sql}
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(userId, ...sheetParams, ...p.params, limit) as any[];

  const httpRows = db.prepare(`
    SELECT id, sheet_id, master_column_name, status, processed_rows, total_rows,
           error_message, target_rows, created_at, updated_at,
           config, spent_micro, pause_reason, skipped_rows, dest_sheet_id, list_rows_added, condition_skipped_rows,
           ai_cost_usd, placeholder_work, autorun_id
    FROM http_runs WHERE user_id = ? AND setup_only = 0 ${sheetSql} ${p.sql}
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(userId, ...sheetParams, ...p.params, limit) as any[];

  const ai: RunSummary[] = aiRows.map(aiRunSummaryFromRow);
  const http: RunSummary[] = httpRows.map(r => ({ ...httpRunSummaryFromRow(r, userId, false), model: null }));

  return [...ai, ...http]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, limit);
}
