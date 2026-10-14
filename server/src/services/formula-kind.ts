// Formula columns as a derived kind (derived-kind.ts): the columns the formula
// reads, run in the sandbox (lib/formula/sandbox.ts). The stored formula is
// compiled against its own inputs, so a {{…}} inside a string that named no
// column when it was saved stays text, whatever columns come later. A row the
// formula can't work out shows its error and is flagged; a few rows out of
// time or memory stop the pass (FORMULA_MAX_RUNAWAYS): the formula is too slow.
import { db } from '../lib/db';
import { FORMULA_MAX_RUNAWAYS } from '../lib/constants';
import { formulaColumnFor, formulaInputs, loadFormulaColumn, type FormulaColumnRow } from '../lib/formula-columns';
import { compileFormula, FormulaError } from '../lib/formula/refs';
import { FormulaSandbox } from '../lib/formula/sandbox';
import { formulaCell, formulaRow } from '../lib/formula/cells';
import type { DerivedCell, DerivedKind, DerivedPass } from './derived-kind';

export const FORMULA_FILLING = 'filling a formula column';

// A pass for a formula over these columns (the fill's, auto-run's, a preview's).
export async function openFormulaPass(formula: string, inputs: string[]): Promise<DerivedPass | { error: string }> {
  let sandbox: FormulaSandbox;
  try {
    sandbox = await FormulaSandbox.open(compileFormula(formula, inputs));
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.message };
    throw e;
  }
  let runaways = 0;
  return {
    compute(rows, budgetMs) {
      const cells: DerivedCell[] = [];
      // The pass stops at the row that makes it too slow; rows after it stay undone.
      for (const o of sandbox.runRows(rows.map(formulaRow), budgetMs).outcomes) {
        if (runaways >= FORMULA_MAX_RUNAWAYS) break;
        if (!o.ok && o.runaway) runaways++;
        const value = formulaCell(o);
        cells.push(o.ok ? { value, filled: value !== '' } : { value, filled: false, flag: o.error });
      }
      return cells;
    },
    prepare: () => sandbox.ensure(),
    failure: () => (runaways >= FORMULA_MAX_RUNAWAYS
      ? `The formula ran out of time or memory on ${runaways} rows, so it stopped. Make it simpler, then save it again.`
      : null),
    dispose: () => sandbox.dispose(),
  };
}

export const formulaKind: DerivedKind<FormulaColumnRow> = {
  id: 'formula',
  table: 'formula_columns',
  busy: FORMULA_FILLING,
  noun: 'formula column',
  load: loadFormulaColumn,
  forColumn: formulaColumnFor,
  inputs: formulaInputs,
  sameSetup: (a, b) => a.formula === b.formula && a.inputs === b.inputs && a.column_name === b.column_name,
  open: rec => openFormulaPass(rec.formula, formulaInputs(rec)),
  advance(rec, cursor, counts) {
    db.prepare(`UPDATE formula_columns SET fill_cursor = ?, filled_rows = filled_rows + ?,
      error_rows = error_rows + ?, first_error = COALESCE(first_error, ?), updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND fill_status = 'filling'`)
      .run(cursor, counts.filled, counts.flagged, counts.firstFlag, rec.id, rec.user_id);
  },
};
