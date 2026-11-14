// get_workspace's answer (mcp/tools-workspace.ts): where an agent is, in one call whose work stays small
// however big the account is. The tables changed most recently (at most OVERVIEW_TABLES) with the sheets
// changed most recently among them (at most OVERVIEW_SHEETS), each sheet's rows counted only up to
// ROW_COUNT_CAP (a 1M-row sheet costs what a 10,000-row one does); the account's totals; and the runs and
// setup runs going now (at most OVERVIEW_RUNS of each). list_tables, list_runs and get_sheet go further.
import { db } from '../lib/db';
import { httpRunModeOf } from '../lib/http-run-mode';
import { httpRunColumn } from './sheet-runs';
import { ACTIVE_STATUS_SQL } from './run-list';

export const OVERVIEW_TABLES = 20, OVERVIEW_SHEETS = 50, OVERVIEW_RUNS = 20, ROW_COUNT_CAP = 10_000;

export interface OverviewSheet {
  id: string; name: string; columns: number | null; row_count: number; row_count_at_least?: true;
  data_version: number; updated_at: string;
}
export interface OverviewTable { id: string; name: string; sheet_count: number; sheets: OverviewSheet[] }
export interface OverviewRun {
  run_type: 'ai' | 'http' | 'enrichment' | 'waterfall'; run_id: string; sheet_id: string; column: string;
  status: 'pending' | 'running' | 'paused'; processed_rows: number; total_rows: number; auto_run: boolean;
}
export interface OverviewSetupRun {
  setup_run_id: string; setup: string; sheet_id: string; status: 'running' | 'paused';
}
export interface Overview {
  table_count: number; sheet_count: number; tables: OverviewTable[];
  active_run_count: number; active_runs: OverviewRun[];
  active_setup_run_count: number; active_setup_runs: OverviewSetupRun[];
}

// The statements whose plans keep the call small, for tests/unit/mcp-get-workspace.test.ts to check.
// A sheet's rows, counted no further than ROW_COUNT_CAP + 1 entries of the (sheet_id, user_id, ...) index. The
// runs and setup runs going now: each WHERE holds a partial index's (migrations 014, 028 and 059), and
// `+user_id` keeps the planner off the user_id index, which on a single account holds every run there ever was.
export const OVERVIEW_SQL = {
  rowCount: 'SELECT COUNT(*) FROM (SELECT 1 FROM rows WHERE sheet_id = ? AND user_id = ? LIMIT ?)',
  runs: `
    SELECT id, sheet_id, status, column_name AS col, NULL AS autorun_id, processed_rows, total_rows, created_at,
           rowid, 0 AS http
    FROM ai_runs WHERE +user_id = ? AND setup_only = 0 AND ${ACTIVE_STATUS_SQL}
    UNION ALL
    SELECT id, sheet_id, status, master_column_name, autorun_id, processed_rows, total_rows, created_at, rowid, 1
    FROM http_runs WHERE +user_id = ? AND setup_only = 0 AND ${ACTIVE_STATUS_SQL}`,
  setupRuns: `SELECT id, setup_name, sheet_id, status, created_at, rowid FROM setup_runs
    WHERE +user_id = ? AND status IN ('running', 'paused')`,
};

function cappedRowCount(sheetId: string, userId: string): Pick<OverviewSheet, 'row_count' | 'row_count_at_least'> {
  const n = db.prepare(OVERVIEW_SQL.rowCount).pluck().get(sheetId, userId, ROW_COUNT_CAP + 1) as number;
  return n > ROW_COUNT_CAP ? { row_count: ROW_COUNT_CAP, row_count_at_least: true } : { row_count: n };
}

// The stored column list's length; null when a sheet with rows has none yet (get_sheet works it out).
function columnCount(order: string | null, rows: number): number | null {
  try {
    const parsed: unknown = order ? JSON.parse(order) : null;
    if (Array.isArray(parsed)) return new Set(parsed.filter(c => typeof c === 'string')).size;
  } catch { /* an unusable list counts as none */ }
  return rows === 0 ? 0 : null;
}

function tablesAndSheets(userId: string): Pick<Overview, 'table_count' | 'sheet_count' | 'tables'> {
  // A table's last change is its own or its newest sheet's (a write to a sheet sets the sheet's updated_at).
  const tables = db.prepare(`
    SELECT t.id, t.name, IFNULL(s.n, 0) AS sheet_count FROM tables t
    LEFT JOIN (SELECT table_id, COUNT(*) AS n, MAX(updated_at) AS changed FROM sheets
      WHERE user_id = ? AND trash_id IS NULL GROUP BY table_id) s ON s.table_id = t.id
    WHERE t.user_id = ? AND t.trash_id IS NULL
    ORDER BY MAX(t.updated_at, IFNULL(s.changed, '')) DESC, t.created_at DESC, t.rowid DESC LIMIT ?
  `).all(userId, userId, OVERVIEW_TABLES) as Array<{ id: string; name: string; sheet_count: number }>;
  const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM tables WHERE user_id = ? AND trash_id IS NULL) AS tables,
      (SELECT COUNT(*) FROM sheets s JOIN tables t ON t.id = s.table_id
        WHERE s.user_id = ? AND s.trash_id IS NULL AND t.trash_id IS NULL) AS sheets`)
    .get(userId, userId) as { tables: number; sheets: number };
  if (!tables.length) return { table_count: totals.tables, sheet_count: totals.sheets, tables: [] };
  // The sheets of those tables changed most recently, shown under their table in the app's order.
  const sheets = db.prepare(`
    SELECT id, table_id, name, position, data_version, updated_at, column_order FROM sheets
    WHERE user_id = ? AND trash_id IS NULL AND table_id IN (${tables.map(() => '?').join(',')})
    ORDER BY updated_at DESC, rowid DESC LIMIT ?
  `).all(userId, ...tables.map(t => t.id), OVERVIEW_SHEETS) as Array<{
    id: string; table_id: string; name: string; position: number; data_version: number; updated_at: string;
    column_order: string | null;
  }>;
  sheets.sort((a, b) => a.position - b.position);
  return {
    table_count: totals.tables, sheet_count: totals.sheets,
    tables: tables.map(t => ({
      ...t,
      sheets: sheets.filter(s => s.table_id === t.id).map(s => {
        const rows = cappedRowCount(s.id, userId);
        return {
          id: s.id, name: s.name, columns: columnCount(s.column_order, rows.row_count), ...rows,
          data_version: s.data_version, updated_at: s.updated_at,
        };
      }),
    })),
  };
}

// Only the runs shown read more (an HTTP run's config, its column).
type Going = {
  id: string; sheet_id: string; status: OverviewRun['status']; col: string | null; autorun_id: string | null;
  processed_rows: number; total_rows: number; created_at: string; rowid: number; http: 0 | 1;
};
function runsGoingNow(userId: string): Pick<Overview, 'active_run_count' | 'active_runs'> {
  const going = (db.prepare(OVERVIEW_SQL.runs).all(userId, userId) as Going[])
    // Oldest first; created_at has one-second steps, so rowid (insert order) breaks a tie within a kind.
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.rowid - b.rowid);
  const configOf = db.prepare('SELECT config FROM http_runs WHERE id = ? AND user_id = ?').pluck();
  return {
    active_run_count: going.length,
    active_runs: going.slice(0, OVERVIEW_RUNS).map(r => {
      const config = r.http ? configOf.get(r.id, userId) as string | null : null;
      return {
        run_type: r.http ? httpRunModeOf(config) : 'ai', run_id: r.id, sheet_id: r.sheet_id,
        column: r.http ? httpRunColumn({ id: r.id, master_column_name: r.col, config }, userId) : r.col ?? '',
        status: r.status, processed_rows: r.processed_rows, total_rows: r.total_rows, auto_run: !!r.autorun_id,
      };
    }),
  };
}

function setupRunsGoingNow(userId: string): Pick<Overview, 'active_setup_run_count' | 'active_setup_runs'> {
  const rows = db.prepare(OVERVIEW_SQL.setupRuns).all(userId) as Array<{
      id: string; setup_name: string; sheet_id: string; status: OverviewSetupRun['status']; created_at: string;
      rowid: number;
    }>;
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.rowid - b.rowid);
  return {
    active_setup_run_count: rows.length,
    active_setup_runs: rows.slice(0, OVERVIEW_RUNS)
      .map(r => ({ setup_run_id: r.id, setup: r.setup_name, sheet_id: r.sheet_id, status: r.status })),
  };
}

export function workspaceOverview(userId: string): Overview {
  return { ...tablesAndSheets(userId), ...runsGoingNow(userId), ...setupRunsGoingNow(userId) };
}
