// The runs working on a sheet now: the AI, HTTP API, enrichment and waterfall
// runs (a waterfall's dry runs too), and the setups being used on it. get_sheet and GET /v1/sheets/:id list them;
// services/sheet-runs-stop.ts stops them all at once.
import { db } from '../lib/db';
import { httpRunModeOf } from '../lib/http-run-mode';
import { waterfallConfigOf } from '../lib/waterfall/config';

export interface SheetRun {
  run_type: 'ai' | 'http' | 'enrichment' | 'waterfall';
  run_id: string;
  status: 'pending' | 'running' | 'paused';
  column: string;    // the column it fills: an AI run's column, a structured one's (Status), an HTTP run's main column
  auto_run: boolean; // a batch the column's auto-run started
}
export interface SheetSetupRun { setup_run_id: string; setup: string; status: 'running' | 'paused' }

// Oldest first. Sorted here, not in SQL: with an ORDER BY a planner without
// statistics walks every run the sheet ever had (an auto-run column makes
// thousands) instead of the partial index of active ones (migration 014),
// whose WHERE each query repeats word for word.
// created_at has one-second steps, so runs started together tie on it: rowid
// (insert order) breaks the tie.
const byStart = (a: { created_at: string; rowid: number }, b: { created_at: string; rowid: number }) =>
  a.created_at.localeCompare(b.created_at) || a.rowid - b.rowid;

export function activeSheetRuns(sheetId: string, userId: string): SheetRun[] {
  const ai = (db.prepare(`SELECT id, status, column_name, created_at, rowid FROM ai_runs
      WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')`)
    .all(sheetId, userId) as Array<{
      id: string; status: SheetRun['status']; column_name: string; created_at: string; rowid: number;
    }>)
    .sort(byStart);
  const http = (db.prepare(`SELECT id, status, master_column_name, autorun_id, config, created_at, rowid FROM http_runs
      WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')`)
    .all(sheetId, userId) as Array<{
      id: string; status: SheetRun['status']; master_column_name: string | null; autorun_id: string | null;
      config: string | null; created_at: string; rowid: number;
    }>).sort(byStart);
  const firstOutput = db.prepare(`SELECT extracted_column_name FROM http_column_associations
    WHERE run_id = ? AND user_id = ? ORDER BY rowid LIMIT 1`).pluck();
  return [
    ...ai.map(r => ({
      run_type: 'ai' as const, run_id: r.id, status: r.status, column: r.column_name, auto_run: false,
    })),
    ...http.map(r => ({
      run_type: httpRunModeOf(r.config), run_id: r.id, status: r.status,
      // A dry run has no column of its own: the one it was started for.
      column: r.master_column_name ?? (firstOutput.get(r.id, userId) as string | undefined)
        ?? waterfallConfigOf(r.config)?.waterfall.dry?.column ?? '',
      auto_run: !!r.autorun_id,
    })),
  ];
}

export function activeSetupRuns(sheetId: string, userId: string): SheetSetupRun[] {
  return (db.prepare(`SELECT id, setup_name, status, created_at, rowid FROM setup_runs
      WHERE sheet_id = ? AND user_id = ? AND status IN ('running', 'paused')`)
    .all(sheetId, userId) as Array<{
      id: string; setup_name: string; status: SheetSetupRun['status']; created_at: string; rowid: number;
    }>).sort(byStart).map(r => ({ setup_run_id: r.id, setup: r.setup_name, status: r.status }));
}
