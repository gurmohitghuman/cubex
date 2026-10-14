// Formulas as people write them (pure): one JavaScript expression reading the
// row as {{Column}}, as in Clay. compileFormula resolves each reference the way
// "Only run if" rules do (exact name, else the one matching ignoring case, else
// by normalized name; a misspelling is refused with the closest name), keeps
// the formula with every name written exactly, and writes the source the
// sandbox runs (sandbox.ts), where each reference reads __v[i]. Inside a quoted
// string or a template literal, a {{…}} naming no column is just text: it is
// kept as {\{…}} (the same text when it runs), so a column made or renamed
// later never turns it into a reference.
import { resolveColumnRef, suggestColumn } from '../column-ref-resolve';
import { FORMULA_MAX_CHARS } from '../constants-formula';
import { FormulaError, FormulaScan, type RefWhere } from './scan';

export { FormulaError } from './scan';

export interface CompiledFormula {
  formula: string;     // as written, every reference naming its column exactly
  source: string;      // what the sandbox runs: the expression with __v[i] for each reference
  inputs: string[];    // the columns it reads, __v's order
  usesLodash: boolean; // reads `_`: the sandbox loads Lodash
}

// A column a formula can't name: "}}" would end the reference, and a name
// ending in "}" or starting with "{" reads as part of the braces.
export function formulaRefProblem(column: string): string | null {
  if (column.includes('}}') || column.endsWith('}') || column.startsWith('{')) {
    return `"${column}" can't be used in a formula: rename it without braces at its ends or "}}".`;
  }
  return null;
}

function resolve(name: string, where: RefWhere, columns: string[]): string | null {
  if (!name) {
    if (where === 'text') return null;
    throw new FormulaError('A column reference is empty: write {{Column name}}.');
  }
  const col = resolveColumnRef(name, columns);
  if (!col) {
    if (where === 'text') return null;
    throw new FormulaError(`There's no column named "${name}".${suggestColumn(name, columns)}`);
  }
  const problem = formulaRefProblem(col);
  if (problem) throw new FormulaError(problem);
  return col;
}

export function compileFormula(text: string, columns: string[]): CompiledFormula {
  const trimmed = text.trim();
  if (!trimmed) throw new FormulaError('Write a formula, like {{Email}}?.split("@")[1].');
  if (trimmed.length > FORMULA_MAX_CHARS) {
    throw new FormulaError(`A formula can be at most ${FORMULA_MAX_CHARS} characters.`);
  }
  const formula = new FormulaScan(trimmed, (name, where, raw) => {
    const col = resolve(name, where, columns);
    return col === null ? { raw: `{\\${raw.slice(1)}` } : { raw: `{{${col}}}` };
  }).run().out;
  const inputs: string[] = [];
  const scan = new FormulaScan(formula, (name, where) => {
    const col = resolve(name, where, columns);
    if (col === null) return null;
    if (!inputs.includes(col)) inputs.push(col);
    return { expr: `__v[${inputs.indexOf(col)}]` };
  }).run();
  return { formula, source: scan.out, inputs, usesLodash: scan.usesLodash };
}

// Column rename: the formula reading the new name. Run only when the formula
// reads the column (its inputs list it) and the new name can be read
// (formulaRefProblem is null): the rename refuses otherwise.
export function renameFormulaRefs(formula: string, oldName: string, newName: string): string {
  try {
    return new FormulaScan(formula, name => (name === oldName ? { raw: `{{${newName}}}` } : null)).run().out;
  } catch {
    return formula;
  }
}
