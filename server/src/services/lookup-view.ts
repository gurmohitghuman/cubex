// What the app and agents are told about lookup columns (a pure read): the
// sheet payload's lookupColumns (the header, the column menu and the Edit
// dialog), the lookup_columns list in get_sheet, and lookup_column's answer.
import { db } from '../lib/db';
import { lookupReturnColumns, sheetLookupColumns, type LookupColumnRow } from '../lib/lookup-columns';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { entryFor } from './autorun-entry';
import { derivedFillWait } from './derived-fill';
import { lookupReads } from './lookup-kind';

export interface LookupColumnView {
  column: string;
  sourceColumn: string;
  otherSheetId: string;
  otherSheet: string | null;     // its name now (null: deleted)
  otherTable: string | null;
  matchColumn: string;
  match: 'equals' | 'contains';
  returns: 'value' | 'exists' | 'count' | 'list';
  returnColumns: string[] | null; // 'value': [the column]; 'list': the columns, null = all
  limit: number;
  autoRun: boolean;
  autoRunNote: string | null;    // why auto-run is paused, when it is
  status: 'filling' | 'done' | 'failed';
  waiting: string | null;        // what a fill waits for (the other sheet sorting…)
  pausedRun: string | null;      // a paused run there hasn't finished a column it reads
  filledRows: number;            // the last fill: cells holding a result
  errorRows: number;             // the last fill: rows showing "❌ <why>"
  firstError: string | null;     // the first of them, "Row N: <why>"
  error: string | null;          // why the fill failed
  broken: string | null;         // why it can't look up any more (the other sheet or a column gone)
}

export function lookupColumnView(r: LookupColumnRow): LookupColumnView {
  const entry = entryFor(r.sheet_id, r.user_id, r.column_name);
  const other = db.prepare(`SELECT s.name AS sheet, t.name AS tbl FROM sheets s JOIN tables t ON t.id = s.table_id
    WHERE s.id = ? AND s.user_id = ?`).get(r.other_sheet_id, r.user_id) as { sheet: string; tbl: string } | undefined;
  return {
    column: r.column_name, sourceColumn: r.source_column, otherSheetId: r.other_sheet_id,
    otherSheet: other?.sheet ?? null, otherTable: other?.tbl ?? null, matchColumn: r.match_column,
    match: r.match_mode, returns: r.returns, returnColumns: lookupReturnColumns(r), limit: r.list_limit,
    autoRun: entry?.enabled === 1,
    autoRunNote: entry?.enabled === 1 && entry.paused_reason ? entry.paused_message : null,
    status: r.fill_status, waiting: r.fill_status === 'filling' ? derivedFillWait(r.id) : null,
    pausedRun: pausedRunNote(r, other?.sheet ?? null),
    filledRows: r.filled_rows, errorRows: r.error_rows, firstError: r.first_error, error: r.error_message,
    broken: r.broken,
  };
}

// A column it reads that only a paused run holds: a fill doesn't wait for it,
// and the rows that run hasn't reached still show ⏳ there, read as empty.
function pausedRunNote(r: LookupColumnRow, otherSheet: string | null): string | null {
  if (!otherSheet || r.broken) return null;
  const held = getLockedRunColumns(r.other_sheet_id, r.user_id);
  if (held.size === 0) return null;
  const moving = getLockedRunColumns(r.other_sheet_id, r.user_id, { paused: false });
  const column = lookupReads(r).find(c => held.has(c) && !moving.has(c));
  return column ? `A paused run hasn't finished "${column}" in "${otherSheet}": its rows still showing ⏳ read `
    + "as empty here. Look every row up again once it's done." : null;
}

// The sheet's lookup columns that are in it now (a record can outlive its column).
export function sheetLookupView(sheetId: string, userId: string, columns: string[]): Record<string, LookupColumnView> {
  const out: Record<string, LookupColumnView> = {};
  for (const r of sheetLookupColumns(sheetId, userId)) {
    if (columns.includes(r.column_name)) out[r.column_name] = lookupColumnView(r);
  }
  return out;
}

// For agents (snake_case, as every MCP and /api/v1 answer).
export function lookupColumnJson(v: LookupColumnView): Record<string, unknown> {
  return {
    column: v.column, source_column: v.sourceColumn, other_sheet_id: v.otherSheetId,
    other_sheet: v.otherSheet, ...(v.otherTable ? { other_table: v.otherTable } : {}),
    match_column: v.matchColumn, match: v.match, returns: v.returns,
    ...(v.returns === 'value' ? { return_column: v.returnColumns?.[0] ?? null } : {}),
    ...(v.returns === 'list' ? { return_columns: v.returnColumns ?? 'all', limit: v.limit } : {}),
    auto_run: v.autoRun, ...(v.autoRunNote ? { auto_run_paused: v.autoRunNote } : {}),
    status: v.status, ...(v.waiting ? { waiting: v.waiting } : {}),
    ...(v.pausedRun ? { paused_run: v.pausedRun } : {}),
    filled_rows: v.filledRows, error_rows: v.errorRows,
    ...(v.firstError ? { first_error: v.firstError } : {}),
    ...(v.error ? { error: v.error } : {}), ...(v.broken ? { broken: v.broken } : {}),
  };
}
