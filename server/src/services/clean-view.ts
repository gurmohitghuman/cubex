// What the app and agents are told about clean data columns (a pure read):
// the sheet payload's cleanColumns (the column menu and the Edit dialog), the
// clean_columns list in get_sheet, and clean_column's answer.
import { sheetCleanColumns, type CleanColumnRow } from '../lib/clean-columns';
import { entryFor } from './autorun-entry';

export interface CleanColumnView {
  column: string;
  source: string;
  cleaner: string;
  options: Record<string, unknown>;
  autoRun: boolean;
  status: 'filling' | 'done' | 'failed';
  cleanedRows: number;   // the last fill: cells it left holding a value
  blankRows: number;     // the last fill: source values the cleaner couldn't read
  error: string | null;
}

function optionsOf(raw: string): Record<string, unknown> {
  try { const o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
  catch { return {}; }
}

export function cleanColumnView(r: CleanColumnRow): CleanColumnView {
  return {
    column: r.column_name, source: r.source_column, cleaner: r.cleaner, options: optionsOf(r.options),
    autoRun: entryFor(r.sheet_id, r.user_id, r.column_name)?.enabled === 1,
    status: r.fill_status, cleanedRows: r.filled_rows, blankRows: r.blanked_rows, error: r.error_message,
  };
}

// The sheet's clean columns that are in it now (a record can outlive its column).
export function sheetCleanView(sheetId: string, userId: string, columns: string[]): Record<string, CleanColumnView> {
  const out: Record<string, CleanColumnView> = {};
  for (const r of sheetCleanColumns(sheetId, userId)) {
    if (columns.includes(r.column_name)) out[r.column_name] = cleanColumnView(r);
  }
  return out;
}

// For agents (snake_case, as every MCP and /api/v1 answer).
export function cleanColumnJson(v: CleanColumnView): Record<string, unknown> {
  return {
    column: v.column, source_column: v.source, cleaner: v.cleaner,
    ...(typeof v.options.phoneFormat === 'string' ? { phone_format: v.options.phoneFormat } : {}),
    ...(typeof v.options.phoneCountry === 'string' ? { phone_country: v.options.phoneCountry } : {}),
    auto_run: v.autoRun, status: v.status, cleaned_rows: v.cleanedRows, blank_rows: v.blankRows,
    ...(v.error ? { error: v.error } : {}),
  };
}
