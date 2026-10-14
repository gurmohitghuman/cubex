// Formula columns' records (formula_columns, migration 025): reading them, and
// keeping them in step with column renames and deletes (services/
// column-rename.ts, column-delete.ts call these in their transactions). A
// record names columns by name, as auto-run does: renaming a column a formula
// reads rewrites its {{reference}}; deleting the formula column forgets the
// record; deleting an input keeps it, with the values already worked out, and
// its auto-run waits until a column by that name is back.
import { db } from './db';
import { renameFormulaRefs } from './formula/refs';

export interface FormulaColumnRow {
  id: string; user_id: string; sheet_id: string; column_name: string; formula: string; inputs: string;
  description: string | null; fill_status: 'filling' | 'done' | 'failed'; fill_cursor: number;
  filled_rows: number; error_rows: number; first_error: string | null; error_message: string | null;
}

export function formulaInputs(rec: Pick<FormulaColumnRow, 'inputs'>): string[] {
  try {
    const v = JSON.parse(rec.inputs);
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function formulaColumnFor(sheetId: string, userId: string, column: string): FormulaColumnRow | undefined {
  return db.prepare('SELECT * FROM formula_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .get(sheetId, userId, column) as FormulaColumnRow | undefined;
}

export function loadFormulaColumn(id: string): FormulaColumnRow | undefined {
  return db.prepare('SELECT * FROM formula_columns WHERE id = ?').get(id) as FormulaColumnRow | undefined;
}

export function sheetFormulaColumns(sheetId: string, userId: string): FormulaColumnRow[] {
  return db.prepare('SELECT * FROM formula_columns WHERE sheet_id = ? AND user_id = ? ORDER BY created_at')
    .all(sheetId, userId) as FormulaColumnRow[];
}

const readers = (sheetId: string, userId: string, column: string): FormulaColumnRow[] =>
  sheetFormulaColumns(sheetId, userId).filter(r => formulaInputs(r).includes(column));

// Inside the rename's transaction: the formula column's own name, and every
// formula reading the column (its {{reference}} and inputs).
export function renameFormulaColumnRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  db.prepare(`UPDATE formula_columns SET column_name = ?, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?`).run(newName, sheetId, userId, oldName);
  const save = db.prepare(`UPDATE formula_columns SET formula = ?, inputs = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`);
  for (const r of readers(sheetId, userId, oldName)) {
    const inputs = formulaInputs(r).map(c => (c === oldName ? newName : c));
    save.run(renameFormulaRefs(r.formula, oldName, newName), JSON.stringify(inputs), r.id, userId);
  }
}

// A CSV replace's last transaction (after the new column list is saved): a
// formula column the file didn't bring back is gone, with its auto-run.
export function forgetUnlistedFormulaColumns(sheetId: string, userId: string): void {
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  let listed: unknown = [];
  try { listed = JSON.parse(order ?? '[]'); } catch { /* none listed */ }
  const keep = JSON.stringify(Array.isArray(listed) ? listed : []);
  db.prepare(`DELETE FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND kind = 'formula'
    AND status_column NOT IN (SELECT value FROM json_each(?))`).run(sheetId, userId, keep);
  db.prepare(`DELETE FROM formula_columns WHERE sheet_id = ? AND user_id = ?
    AND column_name NOT IN (SELECT value FROM json_each(?))`).run(sheetId, userId, keep);
}

// Inside the delete's transaction (its auto-run entry goes with
// deleteAutorunColumnRefs, which pauses the ones that read the column).
export function deleteFormulaColumnRefs(sheetId: string, userId: string, column: string): void {
  db.prepare('DELETE FROM formula_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .run(sheetId, userId, column);
}
