// A rename the formulas reading the column can't follow: each one's
// {{reference}}, rewritten with the new name, must still compile in the
// sandbox. Braces at a name's ends or "}}" can't be written as a reference at
// all, and a quote or a backtick in it can end the string the reference sits
// in. The rename is refused then (services/column-rename.ts), naming the formula.
import { formulaInputs, sheetFormulaColumns } from '../lib/formula-columns';
import { compileFormula, FormulaError, formulaRefProblem, renameFormulaRefs } from '../lib/formula/refs';
import { FormulaSandbox } from '../lib/formula/sandbox';

async function compiles(formula: string, inputs: string[]): Promise<string | null> {
  try {
    (await FormulaSandbox.open(compileFormula(formula, inputs))).dispose();
    return null;
  } catch (e) {
    if (e instanceof FormulaError) return e.message;
    throw e;
  }
}

export async function formulaRenameProblem(
  sheetId: string, userId: string, oldName: string, newName: string,
): Promise<string | null> {
  for (const r of sheetFormulaColumns(sheetId, userId)) {
    const inputs = formulaInputs(r);
    if (!inputs.includes(oldName)) continue;
    const why = formulaRefProblem(newName)
      ?? await compiles(renameFormulaRefs(r.formula, oldName, newName), inputs.map(c => (c === oldName ? newName : c)));
    if (why) {
      return `The formula in "${r.column_name}" reads this column and couldn't use the new name (${why}) `
        + 'Pick another name.';
    }
  }
  return null;
}
