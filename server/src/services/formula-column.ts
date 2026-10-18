// Formula columns: one implementation for the app (routes/sheets-formula.ts),
// /api/v1 and the MCP tool. A formula column is always its own column, worked
// out for free from other columns of its row by a JavaScript expression run in
// the sandbox (lib/formula/): no request, no model call. Naming an existing
// formula column changes its formula and works every row out again; any other
// existing column is refused, so nothing a person typed is overwritten.
// Starting is ONE transaction inside the sheet's busy window: the column joins
// the registry, its record is saved (formula_columns) and its auto-run set;
// the fill then runs in the background with the sheet still busy.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { FORMULA_WORDS_MAX_CHARS, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import {
  columnCollisionMessage, findColumnNameCollision, sanitizeAndValidateColumnName,
} from '../lib/column-names';
import { busyMessage, continueInBackground, sheetBusyWith, withSheetBusy } from '../lib/sheet-busy';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { derivedLoopThrough } from '../lib/derived-loops';
import { formulaColumnFor, type FormulaColumnRow } from '../lib/formula-columns';
import { compileFormula, FormulaError, type CompiledFormula } from '../lib/formula/refs';
import { runDerivedFill } from './derived-fill';
import { setDerivedAutorun } from './derived-autorun';
import { FORMULA_FILLING, formulaKind, openFormulaPass } from './formula-kind';
import type { RunFail } from './run-shared';
import { logSheetChange } from '../lib/change-log';

export interface FormulaColumnInput {
  formula: unknown;
  column?: unknown;       // the formula column's name (a preview can leave it out)
  description?: unknown;  // the plain words it was written from
  autoRun?: boolean;      // on for a new column; unchanged for an existing one when left out
}

// isNew: the column isn't in the sheet yet (a record can outlive its column).
export interface FormulaSetup {
  compiled: CompiledFormula; column: string | null; description: string | null;
  existing: FormulaColumnRow | undefined; isNew: boolean;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// The input, checked against the sheet as it is now (start checks it again
// inside its transaction). A preview may leave the column out.
export function checkFormulaInput(
  userId: string, sheetId: string, input: FormulaColumnInput, opts: { needColumn?: boolean } = {},
): FormulaSetup | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (typeof input.formula !== 'string') return bad('Write the formula as text, like {{Email}}?.split("@")[1].');
  const columns = getSheetColumns(sheetId, userId, false);
  let compiled: CompiledFormula;
  try {
    compiled = compileFormula(input.formula, columns);
  } catch (e) {
    if (e instanceof FormulaError) return bad(e.message);
    throw e;
  }
  const words = input.description;
  if (words !== undefined && words !== null && typeof words !== 'string') return bad('description must be text.');
  if (typeof words === 'string' && words.length > FORMULA_WORDS_MAX_CHARS) {
    return bad(`description can be at most ${FORMULA_WORDS_MAX_CHARS} characters.`);
  }
  const description = typeof words === 'string' && words.trim() ? words.trim() : null;
  const empty = input.column === undefined || input.column === null || input.column === '';
  if (empty) {
    if (opts.needColumn !== false) return bad('Name the formula column (column).');
    return { compiled, column: null, description, existing: undefined, isNew: true };
  }
  if (typeof input.column !== 'string') return bad('column must be a column name.');
  const named = sanitizeAndValidateColumnName(input.column);
  if ('error' in named) return bad(named.error);
  const setup: FormulaSetup = {
    compiled, column: named.name, description,
    existing: formulaColumnFor(sheetId, userId, named.name), isNew: !columns.includes(named.name),
  };
  return placeProblem(sheetId, userId, setup, columns) ?? setup;
}

// Where the formula column goes: a new name (no clash, under the column cap),
// or a formula column already there; never one it reads, never a loop.
function placeProblem(sheetId: string, userId: string, s: FormulaSetup, columns: string[]): RunFail | null {
  const column = s.column!;
  if (!s.isNew && !s.existing) {
    return { fail: 'conflict', message: `"${column}" is already a column. Pick a new name for the formula column.` };
  }
  if (s.isNew) {
    const clash = findColumnNameCollision(column, columns);
    if (clash) return { fail: 'conflict', message: columnCollisionMessage(column, clash) };
    if (columns.length >= MAX_COLUMNS_PER_SHEET) {
      return {
        fail: 'cap', message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.`,
      };
    }
  }
  if (s.compiled.inputs.includes(column)) return bad(`A formula can't read its own column, "${column}".`);
  const loop = derivedLoopThrough(sheetId, userId, column, s.compiled.inputs);
  if (loop) return bad(`The formula can't read ${loop}: that is worked out from "${column}" itself.`);
  if (getLockedRunColumns(sheetId, userId).has(column)) {
    return { fail: 'conflict', message: `A run is writing "${column}". Stop it first.` };
  }
  return null;
}

// A syntax error shows when the sandbox compiles the formula: before saving.
export async function formulaSyntaxProblem(compiled: CompiledFormula): Promise<RunFail | null> {
  const pass = await openFormulaPass(compiled.formula, compiled.inputs);
  if ('error' in pass) return bad(pass.error);
  pass.dispose();
  return null;
}

export type FormulaStart = { ok: { id: string; column: string; created: boolean } } | RunFail;

export async function startFormulaColumn(
  userId: string, sheetId: string, input: FormulaColumnInput,
): Promise<FormulaStart> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const first = checkFormulaInput(userId, sheetId, input);
  if ('fail' in first) return first;
  const syntax = await formulaSyntaxProblem(first.compiled);
  if (syntax) return syntax;
  const out = await withSheetBusy(sheetId, FORMULA_FILLING, async (): Promise<FormulaStart> => {
    const result = db.transaction((): FormulaStart => {
      // Again inside the write lock: the sheet may have changed since the checks.
      const s = checkFormulaInput(userId, sheetId, input);
      if ('fail' in s) return s;
      const column = s.column!;
      const created = s.isNew;
      if (created) appendColumnsToOrder(sheetId, userId, [column]);
      const id = s.existing?.id ?? uuidv4();
      db.prepare(`INSERT INTO formula_columns (id, user_id, sheet_id, column_name, formula, inputs, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sheet_id, column_name) DO UPDATE SET formula = excluded.formula, inputs = excluded.inputs,
          description = excluded.description, fill_status = 'filling', fill_cursor = 0, filled_rows = 0,
          error_rows = 0, first_error = NULL, error_message = NULL, updated_at = datetime('now')`)
        .run(id, userId, sheetId, column, s.compiled.formula, JSON.stringify(s.compiled.inputs), s.description);
      setDerivedAutorun('formula', sheetId, userId, column, s.compiled.inputs,
        input.autoRun ?? (created ? true : undefined));
      db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`).run(sheetId, userId);
      const verb = created ? 'Added' : 'Changed';
      logSheetChange(sheetId, userId, 'formula_column', `${verb} the formula column "${column}"`,
        { column, detail: { formula: s.compiled.formula } });
      return { ok: { id, column, created } };
    }).immediate();
    if ('ok' in result) continueInBackground(sheetId, FORMULA_FILLING, () => runDerivedFill(formulaKind, result.ok.id));
    return result;
  });
  return 'busy' in out && typeof out.busy === 'string' ? { fail: 'conflict', message: out.busy } : out as FormulaStart;
}

// Auto-run on or off for a formula column (the column menu, MCP set_auto_run).
// Turning it on (from off) works every row out again first: rows whose inputs
// changed while it was off would otherwise keep their old values. Turning it
// on while it's on lifts a pause. It has no rule or caps.
export async function setFormulaColumnAutorun(
  userId: string, sheetId: string, rec: FormulaColumnRow, enabled: boolean,
): Promise<{ ok: { column: string } } | RunFail> {
  if (!enabled) {
    db.transaction(() => setDerivedAutorun('formula', sheetId, userId, rec.column_name, [], false)).immediate();
    return { ok: { column: rec.column_name } };
  }
  const on = db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL,
      rescan = 1, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND status_column = ? AND enabled = 1`)
    .run(sheetId, userId, rec.column_name).changes > 0;
  if (on) return { ok: { column: rec.column_name } };
  const started = await startFormulaColumn(userId, sheetId, {
    formula: rec.formula, column: rec.column_name, description: rec.description, autoRun: true,
  });
  return 'fail' in started ? started : { ok: { column: rec.column_name } };
}
