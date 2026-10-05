import { db } from './db';
import { jsonPath } from './sql-rows';
import { clearProcessingPlaceholders } from './placeholder-cells';

// True if a row this run was supposed to process is GENUINELY unfinished: its
// placeholder column still holds '⏳ Processing...' AND there's no result row for
// (run_id, row_index) in the run's results table. A worker writes a result row for
// every row it touches (success OR failure), so a placeholder-with-no-result means
// the row was SKIPPED by an unexpected throw — the run must NOT be marked
// 'completed' (the cell would spin forever with no retry path).
//
// The results-table join is what makes this collision-proof: a cell whose value
// legitimately ended up as the literal '⏳ Processing...' still has a result row, so
// it's excluded. targetRows scopes a rerun to its subset, so a stray literal in a
// non-target row can't trip it (full run → undefined → all rows). Both result
// tables are 1-row-per-processed-row, run-scoped. Shared by AI finalizeStatus and
// the HTTP completed-branch so they decide "genuinely stuck" identically.
export function hasUnfinishedRow(args: {
  resultsTable: 'ai_results' | 'http_results';
  runId: string;
  sheetId: string;
  userId: string;
  placeholderColumn: string;
  targetRows?: number[];
}): boolean {
  const { resultsTable, runId, sheetId, userId, placeholderColumn, targetRows } = args;
  const sql =
    `SELECT r.row_index FROM rows r
     WHERE r.sheet_id = ? AND r.user_id = ?
       AND json_extract(r.data, ?) = '⏳ Processing...'
       AND NOT EXISTS (
         SELECT 1 FROM ${resultsTable} res WHERE res.run_id = ? AND res.row_index = r.row_index
       )`;
  const params: Array<string | number> = [sheetId, userId, jsonPath(placeholderColumn), runId];
  if (!targetRows || targetRows.length === 0) return !!db.prepare(sql + ' LIMIT 1').get(...params);
  if (targetRows.length <= TARGETS_AS_PARAMS) {
    return !!db.prepare(sql + ' AND r.row_index IN (' + targetRows.map(() => '?').join(',') + ') LIMIT 1')
      .get(...params, ...targetRows);
  }
  // A big rerun's targets would pass SQLite's parameter limit: page through the
  // candidates in row order and check them here instead.
  const inTargets = new Set(targetRows);
  const page = db.prepare(sql + ' AND r.row_index > ? ORDER BY r.row_index LIMIT 1000').pluck();
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const indexes = page.all(...params, after) as number[];
    if (indexes.length === 0) return false;
    if (indexes.some(i => inTargets.has(i))) return true;
    after = indexes[indexes.length - 1];
  }
}

const TARGETS_AS_PARAMS = 500;

// Resolve the cells an AI/HTTP run writes a "⏳ Processing..." placeholder into,
// and clear any that survive a terminal transition (cancel, a worker's failure,
// a start that could not finish). These helpers are the single source of truth
// so every path that takes a run out of 'running'/'pending' clears placeholders
// the same way.
//
// Worker note: the AI/HTTP runners run in Sidequest worker threads, where
// importing '../lib/db' yields a fresh connection to the SAME cubex.db file.
// clearProcessingPlaceholders and the association lookup below both bind that
// module-level `db`, so they operate on the caller's own connection in every
// context (main process for orphan-runs, worker thread for the runners).

interface AIRunCols {
  column_name: string;
  use_openrouter_web_search: number;
  output_columns?: string | null; // JSON [{columnName,...}] for structured runs
}

// Columns an AI run targets. Single-column run: the Output column (+ "(Data)"
// when web search is on). Structured (multi-column) run: column_name is the
// STATUS column and output_columns lists the N typed columns — all of them hold
// a '⏳ Processing...' placeholder and must be cleared together, or the extra
// columns spin forever after a cancel/fail. output_columns and web search are
// mutually exclusive (parse rejects the combo), so the branches don't overlap.
function aiRunColumns(run: AIRunCols): string[] {
  const columns = [run.column_name];
  if (run.output_columns) {
    try {
      for (const s of JSON.parse(run.output_columns) as Array<{ columnName?: unknown }>) {
        if (s && typeof s.columnName === 'string') columns.push(s.columnName);
      }
    } catch { /* malformed spec — clear at least the status column */ }
  } else if (run.use_openrouter_web_search) {
    const dataCol = run.column_name.endsWith(' (Output)')
      ? run.column_name.replace(/ \(Output\)$/, ' (Data)')
      : `${run.column_name} (Data)`;
    columns.push(dataCol);
  }
  return columns;
}

// Columns an HTTP run targets: the optional master/status column plus every
// extracted column from http_column_associations. Mirrors http-jobs.ts cancel.
function httpRunColumns(
  runId: string,
  userId: string,
  masterColumnName: string | null,
): string[] {
  const extracted = (db.prepare(
    'SELECT extracted_column_name FROM http_column_associations WHERE run_id = ? AND user_id = ?',
  ).all(runId, userId) as Array<{ extracted_column_name: string }>)
    .map(r => r.extracted_column_name);
  return [
    ...(masterColumnName ? [masterColumnName] : []),
    ...extracted,
  ];
}

export type RunKind = 'ai' | 'http';
const RUN_TABLE: Record<RunKind, string> = { ai: 'ai_runs', http: 'http_runs' };

// Clear the placeholders a run that has just ended still holds, then drop its
// placeholder_work='clearing' mark (migration 004). Whoever ends the run sets
// that mark in the same statement (cancel, a worker's failure, a start that
// could not finish), so a restart midway finishes the clear
// (resumeRunCleanups) and a sort, which moves rows, waits for it. Works in
// slices; safe to call twice.
export async function clearRunPlaceholders(kind: RunKind, runId: string): Promise<void> {
  const table = RUN_TABLE[kind];
  const run = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(runId) as
    (AIRunCols & { id: string; sheet_id: string; user_id: string; master_column_name?: string | null }) | undefined;
  if (!run) return;
  const columns = kind === 'ai' ? aiRunColumns(run) : httpRunColumns(run.id, run.user_id, run.master_column_name ?? null);
  // updated_at is the clear's heartbeat: the stale sweep below retries only a
  // clear that stopped making progress, never a slow one still walking rows.
  const beat = db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE id = ?`);
  await clearProcessingPlaceholders(run.sheet_id, run.user_id, columns, () => { beat.run(runId); });
  db.prepare(`UPDATE ${table} SET placeholder_work = NULL WHERE id = ? AND placeholder_work = 'clearing'`).run(runId);
}

// Finish the clears a restart interrupted (at boot, after the server listens:
// every run marked 'clearing'), or, with `staleMinutes`, retry the ones whose
// clear made no progress for that long (it beats updated_at every slice).
// Running a clear twice is harmless; one already running here is skipped.
const clearing = new Set<string>();

export function resumeRunCleanups(staleMinutes?: number): void {
  const stale = staleMinutes === undefined ? '' : ` AND updated_at < datetime('now', '-${Math.floor(staleMinutes)} minutes')`;
  const pending = [
    ...(db.prepare(`SELECT id FROM ai_runs WHERE placeholder_work = 'clearing'${stale}`).pluck().all() as string[])
      .map(id => ['ai', id] as const),
    ...(db.prepare(`SELECT id FROM http_runs WHERE placeholder_work = 'clearing'${stale}`).pluck().all() as string[])
      .map(id => ['http', id] as const),
  ].filter(([, id]) => !clearing.has(id));
  if (pending.length === 0) return;
  for (const [, id] of pending) clearing.add(id);
  void (async () => {
    for (const [kind, id] of pending) {
      try { await clearRunPlaceholders(kind, id); }
      catch (err) { console.error(`Clearing the cells of ${kind} run ${id} failed:`, err); }
      finally { clearing.delete(id); }
    }
  })();
}

// Clear placeholders for ALL of a sheet's runs, scoped to the columns those runs
// actually own (NOT every column on the sheet — a blanket value-match clear could
// wipe a legit user cell that literally contains "⏳ Processing..."). Used by the
// CSV-replace rollback path: if we aborted active runs but the replace then
// failed, the surviving rows can hold ⏳ cells no live worker will ever clear.
export async function clearPlaceholdersForSheetRuns(sheetId: string, userId: string): Promise<void> {
  const aiRuns = db.prepare(
    'SELECT column_name, use_openrouter_web_search, output_columns FROM ai_runs WHERE sheet_id = ? AND user_id = ?',
  ).all(sheetId, userId) as AIRunCols[];
  const httpRuns = db.prepare(
    'SELECT id, master_column_name FROM http_runs WHERE sheet_id = ? AND user_id = ?',
  ).all(sheetId, userId) as Array<{ id: string; master_column_name: string | null }>;

  const columns = new Set<string>();
  for (const r of aiRuns) for (const c of aiRunColumns(r)) columns.add(c);
  for (const r of httpRuns) for (const c of httpRunColumns(r.id, userId, r.master_column_name)) columns.add(c);
  if (columns.size > 0) await clearProcessingPlaceholders(sheetId, userId, Array.from(columns));
}
