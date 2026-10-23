// Writing a sheet's change log (migration 037; reads: services/sheet-history.ts).
// One line per setup change or big change to the rows, with who made it
// (lib/actor.ts). A log line is a record of what already happened: writing it
// never fails the change itself (an error is only logged), and a call inside
// the change's transaction is kept or rolled back with it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db';
import { currentActor } from './actor';

export type ChangeAction =
  | 'column_added' | 'column_renamed' | 'column_deleted'
  | 'run_started' | 'run_paused' | 'run_resumed' | 'run_stopped' | 'runs_stopped' | 'run_undone'
  | 'auto_run' | 'auto_dedupe' | 'default_model'
  | 'clean_column' | 'formula_column' | 'lookup_column' | 'answer_field' | 'list_fields'
  | 'view_created' | 'view_changed' | 'view_deleted'
  | 'webhook' | 'setup_used' | 'description'
  | 'sheet_renamed' | 'sheet_deleted' | 'sheet_restored' | 'sheet_copied'
  | 'rows_deleted' | 'rows_restored' | 'rows_imported' | 'rows_sorted' | 'duplicates_removed'
  | 'rows_moved_in' | 'rows_moved_out' | 'sample_created'
  | 'setup_version_saved' | 'setup_version_restored';

export interface ChangeExtra { column?: string | null; detail?: Record<string, unknown> }

// Steps that a logged change sets off (a setup's runs and columns) log
// nothing of their own: the setup's line says it.
const quiet = new AsyncLocalStorage<true>();
export const withoutChangeLog = <T>(fn: () => T): T => quiet.run(true, fn);

export function logSheetChange(
  sheetId: string, userId: string, action: ChangeAction, summary: string, extra: ChangeExtra = {},
): number | null {
  if (quiet.getStore()) return null;
  try {
    const actor = currentActor();
    const info = db.prepare(`INSERT INTO sheet_changes (user_id, sheet_id, via, token_name, action, column_name,
        summary, detail) SELECT ?, id, ?, ?, ?, ?, ?, ? FROM sheets WHERE id = ? AND user_id = ?`)
      .run(userId, actor.via, actor.tokenName, action, extra.column ?? null, summary,
        extra.detail ? JSON.stringify(extra.detail) : null, sheetId, userId);
    return info.changes > 0 ? Number(info.lastInsertRowid) : null;
  } catch (error) {
    console.error(`Writing the change log of sheet ${sheetId} failed:`, error);
    return null;
  }
}

// A change that grew after it was logged (a grid delete sent in several calls
// landing in one trash batch): its line says the whole of it.
export function rewriteSheetChange(id: number, summary: string, detail: Record<string, unknown>): void {
  try {
    db.prepare('UPDATE sheet_changes SET summary = ?, detail = ? WHERE id = ?')
      .run(summary, JSON.stringify(detail), id);
  } catch (error) {
    console.error(`Rewriting change ${id} failed:`, error);
  }
}

// "1 row", "1,240 rows": counts in log lines and trash answers.
export const countOf = (n: number, word: string): string =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// A run started by someone (not an auto-run batch, which logs nothing): what
// it runs, on how many rows, with which model and "Only run if" rule.
export interface RunLog {
  kind: 'ai' | 'http' | 'enrichment' | 'waterfall'; column: string; runId: string; rows: number | null;
  again?: boolean; model?: string | null; runIf?: string | null;
}
export function logRunStarted(sheetId: string, userId: string, r: RunLog): void {
  const what = r.kind === 'ai' ? 'the AI column' : r.kind === 'http' ? 'the HTTP API column'
    : r.kind === 'waterfall' ? 'the waterfall' : 'the enrichment';
  const rows = r.rows === null ? '' : ` on ${countOf(r.rows, 'row')}`;
  logSheetChange(sheetId, userId, 'run_started',
    `${r.again ? 'Ran again' : 'Ran'} ${what} "${r.column}"${rows}${r.model ? ` with ${r.model}` : ''}`,
    { column: r.column, detail: {
      run_id: r.runId, kind: r.kind, rows: r.rows, again: !!r.again, model: r.model ?? null, run_if: r.runIf ?? null,
    } });
}

// Someone paused, resumed or stopped a run (Cubex's own stops, such as a
// setup's or a restart's, log nothing).
export function logRunControl(
  sheetId: string, userId: string, action: 'run_paused' | 'run_resumed' | 'run_stopped',
  column: string | null, runId: string,
): void {
  if (currentActor().via === 'cubex') return;
  const verb = action === 'run_paused' ? 'Paused' : action === 'run_resumed' ? 'Resumed' : 'Stopped';
  logSheetChange(sheetId, userId, action, `${verb} the run of "${column ?? 'a column'}"`,
    { column, detail: { run_id: runId } });
}

// Auto-run turned on or off for a column (with its rule), or paused and resumed.
export function logAutorunSaved(
  sheetId: string, userId: string,
  input: { column: string; enabled: boolean; runIf?: string | null; where?: unknown;
    dailyCapUsd?: number | null; dailyRowCap?: number | null },
): void {
  const rule = input.enabled && input.runIf ? ` (only if ${input.runIf})` : '';
  logSheetChange(sheetId, userId, 'auto_run', `Turned auto-run ${input.enabled ? 'on' : 'off'} for "${input.column}"${rule}`,
    { column: input.column, detail: {
      enabled: input.enabled, run_if: input.runIf ?? null, where: input.where ?? null,
      daily_cap_usd: input.dailyCapUsd ?? null, daily_row_cap: input.dailyRowCap ?? null,
    } });
}
export function logAutorunPaused(sheetId: string, userId: string, paused: boolean, column?: string): void {
  logSheetChange(sheetId, userId, 'auto_run',
    `${paused ? 'Paused' : 'Resumed'} auto-run ${column === undefined ? 'of every column' : `of "${column}"`}`,
    { column: column ?? null, detail: { paused } });
}
