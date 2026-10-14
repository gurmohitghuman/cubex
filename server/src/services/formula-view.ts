// What the app and agents are told about formula columns (a pure read): the
// sheet payload's formulaColumns (the header, the column menu and the Edit
// dialog), the formula_columns list in get_sheet, and formula_column's answer.
import { formulaInputs, sheetFormulaColumns, type FormulaColumnRow } from '../lib/formula-columns';
import { entryFor } from './autorun-entry';

export interface FormulaColumnView {
  column: string;
  formula: string;
  inputs: string[];
  description: string | null;
  autoRun: boolean;
  autoRunNote: string | null;   // why auto-run is paused, when it is
  status: 'filling' | 'done' | 'failed';
  filledRows: number;           // the last fill: cells holding a result
  errorRows: number;            // the last fill: rows showing "❌ <the error>"
  firstError: string | null;    // the first of them, "Row N: <the error>"
  error: string | null;         // why the fill failed
}

export function formulaColumnView(r: FormulaColumnRow): FormulaColumnView {
  const entry = entryFor(r.sheet_id, r.user_id, r.column_name);
  return {
    column: r.column_name, formula: r.formula, inputs: formulaInputs(r), description: r.description,
    autoRun: entry?.enabled === 1,
    autoRunNote: entry?.enabled === 1 && entry.paused_reason ? entry.paused_message : null,
    status: r.fill_status, filledRows: r.filled_rows, errorRows: r.error_rows, firstError: r.first_error,
    error: r.error_message,
  };
}

// The sheet's formula columns that are in it now (a record can outlive its column).
export function sheetFormulaView(
  sheetId: string, userId: string, columns: string[],
): Record<string, FormulaColumnView> {
  const out: Record<string, FormulaColumnView> = {};
  for (const r of sheetFormulaColumns(sheetId, userId)) {
    if (columns.includes(r.column_name)) out[r.column_name] = formulaColumnView(r);
  }
  return out;
}

// For agents (snake_case, as every MCP and /api/v1 answer).
export function formulaColumnJson(v: FormulaColumnView): Record<string, unknown> {
  return {
    column: v.column, formula: v.formula, reads: v.inputs,
    ...(v.description ? { description: v.description } : {}),
    auto_run: v.autoRun, ...(v.autoRunNote ? { auto_run_paused: v.autoRunNote } : {}),
    status: v.status, filled_rows: v.filledRows, error_rows: v.errorRows,
    ...(v.firstError ? { first_error: v.firstError } : {}),
    ...(v.error ? { error: v.error } : {}),
  };
}
