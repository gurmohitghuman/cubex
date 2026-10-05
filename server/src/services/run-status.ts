// Lean run-status + per-row-results readers for the programmatic surfaces
// (/api/v1 run endpoints + the MCP get_run_status tool). Deliberately NOT the
// UI's SELECT-* dumps: summaries omit prompts/configs (fetchable elsewhere,
// and configs can embed key REFERENCES), and results are keyset-paged by
// row_index with the row's STABLE id joined on (v1 clients address by id).
import { db } from '../lib/db';
import { parseTargetRows } from '../lib/run-targets';
import { aiRunDataColumn } from '../lib/ai-data-column';

export interface RunSummary {
  id: string;
  sheet_id: string;
  type: 'ai' | 'http';
  column_name: string | null;   // AI: "<name> (Output)", or "<name> (Status)" with output_columns; HTTP: master/status column
  model?: string | null;        // AI only
  output_columns?: string[];    // AI structured run: the typed columns it fills
  data_column?: string;         // AI run with web tools: the "(Data)" column listing its sources
  status: string;
  processed_rows: number;
  total_rows: number;
  target_row_count: number | null; // non-null when the run targets a row subset
  error_message: string | null;
  // Rows that came back ❌ vs with a result. A run is "completed" when it has
  // processed every row, failed ones included, so these say whether it worked.
  failed_rows: number;
  succeeded_rows: number;
  created_at: string;
  updated_at: string;
}

// An index-only range scan on (run_id, status) (migration 005): about 30 ms
// for a run with a million results, so list_runs over many huge runs adds up.
export function rowOutcomes(table: 'ai_results' | 'http_results', runId: string): { failed_rows: number; succeeded_rows: number } {
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM ${table} WHERE run_id = ? GROUP BY status`)
    .all(runId) as Array<{ status: string; n: number }>;
  const n = (s: string) => counts.find(c => c.status === s)?.n ?? 0;
  return { failed_rows: n('failed'), succeeded_rows: n('completed') + n('accepted') };
}

function outputColumnNames(json: string | null): string[] | null {
  if (!json) return null;
  try { return (JSON.parse(json) as Array<{ columnName: string }>).map(s => s.columnName); } catch { return null; }
}

// One ai_runs row as a summary (the SELECTs here and in run-list.ts list the
// columns it reads, written out so the SQL schema test checks them). Says which
// columns the run fills, so a caller reading a structured run knows where its
// values landed.
export function aiRunSummaryFromRow(r: any): RunSummary {
  const outputs = outputColumnNames(r.output_columns);
  const data = aiRunDataColumn(r);
  return {
    id: r.id, sheet_id: r.sheet_id, type: 'ai', column_name: r.column_name,
    model: r.model, ...(outputs ? { output_columns: outputs } : {}), ...(data ? { data_column: data } : {}),
    status: r.status, processed_rows: r.processed_rows,
    total_rows: r.total_rows, target_row_count: parseTargetRows(r.target_rows)?.length ?? null,
    error_message: r.error_message, ...rowOutcomes('ai_results', r.id),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function getAiRunSummary(runId: string, userId: string): RunSummary | null {
  const r = db.prepare(`
    SELECT id, sheet_id, column_name, model, status, processed_rows, total_rows, error_message,
           target_rows, created_at, updated_at, output_columns, data_column, use_openrouter_web_search
    FROM ai_runs WHERE id = ? AND user_id = ?
  `).get(runId, userId);
  return r ? aiRunSummaryFromRow(r) : null;
}

export function getHttpRunSummary(runId: string, userId: string): RunSummary | null {
  const r = db.prepare(`
    SELECT id, sheet_id, master_column_name, status, processed_rows, total_rows,
           error_message, target_rows, created_at, updated_at
    FROM http_runs WHERE id = ? AND user_id = ?
  `).get(runId, userId) as any;
  if (!r) return null;
  return {
    id: r.id, sheet_id: r.sheet_id, type: 'http', column_name: r.master_column_name,
    status: r.status, processed_rows: r.processed_rows,
    total_rows: r.total_rows, target_row_count: parseTargetRows(r.target_rows)?.length ?? null,
    error_message: r.error_message, ...rowOutcomes('http_results', r.id),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export interface RunResultsPage {
  results: Array<{
    row_id: string | null;   // stable rows.id; null if the row was deleted since
    row_index: number;
    status: string;
    value?: string | null;                       // AI output
    extracted_fields?: Record<string, unknown>;  // HTTP extractions
    error_message: string | null;
  }>;
  next_cursor: number | null;
}

// Which per-row results to return. 'failed' is the diagnostic case (why did
// 200 of 1000 rows come back blank?) and MUST filter in SQL, not after paging —
// post-filtering a page would return an empty array alongside a non-null cursor,
// making a caller think it had seen everything when it had seen one page of
// successes. 'all' preserves the original unfiltered behavior.
export type RunResultStatusFilter = 'failed' | 'completed' | 'all';

// SQL fragment + params for a status filter. Both tables spell an error 'failed'
// (ai_results and http_results CHECK constraints agree), so one mapping serves.
function statusClause(filter: RunResultStatusFilter): { sql: string; params: string[] } {
  if (filter === 'all') return { sql: '', params: [] };
  return { sql: 'AND res.status = ?', params: [filter] };
}

// Keyset page over a run's per-row results, ordered by row_index. `after` is
// the previous page's next_cursor (-1 for the first page). Returns null when
// the run doesn't exist / isn't owned.
export function getAiRunResults(
  runId: string, userId: string, after: number, limit: number,
  filter: RunResultStatusFilter = 'all',
): RunResultsPage | null {
  const run = db.prepare('SELECT sheet_id FROM ai_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { sheet_id: string } | undefined;
  if (!run) return null;
  const f = statusClause(filter);
  const rows = db.prepare(`
    SELECT res.row_index, res.status, res.output_value, res.error_message, r.id AS row_id
    FROM ai_results res
    LEFT JOIN rows r ON r.sheet_id = ? AND r.user_id = res.user_id AND r.row_index = res.row_index
    WHERE res.run_id = ? AND res.user_id = ? AND res.row_index > ? ${f.sql}
    ORDER BY res.row_index ASC LIMIT ?
  `).all(run.sheet_id, runId, userId, after, ...f.params, limit) as any[];
  return {
    results: rows.map(r => ({
      row_id: r.row_id ?? null, row_index: r.row_index, status: r.status,
      value: r.output_value, error_message: r.error_message,
    })),
    next_cursor: rows.length === limit ? rows[rows.length - 1].row_index : null,
  };
}

export function getHttpRunResults(
  runId: string, userId: string, after: number, limit: number,
  filter: RunResultStatusFilter = 'all',
): RunResultsPage | null {
  const run = db.prepare('SELECT sheet_id FROM http_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { sheet_id: string } | undefined;
  if (!run) return null;
  const f = statusClause(filter);
  const rows = db.prepare(`
    SELECT res.row_index, res.status, res.extracted_fields, res.error_message, r.id AS row_id
    FROM http_results res
    LEFT JOIN rows r ON r.sheet_id = ? AND r.user_id = res.user_id AND r.row_index = res.row_index
    WHERE res.run_id = ? AND res.user_id = ? AND res.row_index > ? ${f.sql}
    ORDER BY res.row_index ASC LIMIT ?
  `).all(run.sheet_id, runId, userId, after, ...f.params, limit) as any[];
  return {
    results: rows.map(r => {
      let extracted: Record<string, unknown> = {};
      try { extracted = r.extracted_fields ? JSON.parse(r.extracted_fields) : {}; } catch { /* {} */ }
      return {
        row_id: r.row_id ?? null, row_index: r.row_index, status: r.status,
        extracted_fields: extracted, error_message: r.error_message,
      };
    }),
    next_cursor: rows.length === limit ? rows[rows.length - 1].row_index : null,
  };
}
