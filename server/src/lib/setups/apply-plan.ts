// A setup fitted to the sheet it's used on (pure): each input matched to a
// column of the sheet (the one picked, else the one with its name: exactly,
// ignoring case, or by normalized name), columns renamed where asked (a step
// by its main column, an AI step by its base name so its Output, Status and
// Data columns follow; an output column of an HTTP API, enrichment or
// structured AI step on its own), every reference rewritten in one pass
// (remap.ts), then checked: a column it makes that the sheet has already must
// be one a step can carry on (again.ts; `existing` is the sheet's filled
// columns), and the result must hold together (check.ts). layers says when
// each step starts, modes whether it makes its columns or carries them on.
import { resolveColumnRef } from '../column-ref-resolve';
import { sanitizeAndValidateColumnName } from '../column-names';
import { TEMPLATE_TOKEN_RE } from '../http-request-template';
import { templateTokenIs } from '../template-token-match';
import { columnLookup, requestTexts } from './refs';
import { specLayers, specProblem } from './check';
import { remapSpec, stepRenames } from './remap';
import { mainColumn, stepColumns, type SetupSpec } from './spec';
import { fitToSheet, type SheetColumnStep, type StepMode } from './again';

export interface ApplyChoices {
  inputs?: Record<string, string>;  // the setup's input → a column of the sheet
  names?: Record<string, string>;   // a column a step makes → the name it gets
}

export type ApplyPlan =
  | { ok: { spec: SetupSpec; inputs: Record<string, string>; layers: number[]; makes: string[]; modes: StepMode[] } }
  | { problem: string; missing?: string[]; taken?: string[] };

const AI_SUFFIX = / \((Output|Status)\)$/;
const list = (names: string[]) => names.map(n => `"${n}"`).join(', ');

// The sheet column an input goes to when none is picked.
export const matchInput = (input: string, columns: string[]): string | null => resolveColumnRef(input, columns);

// A /word in a request that names none of the setup's columns is plain text
// (a path such as "/users"), but it would read a column of this sheet with
// that name instead: refused, so a request never quietly sends a cell.
function strayPathProblem(spec: SetupSpec, columns: string[]): string | null {
  const own = columnLookup([...spec.inputs, ...spec.steps.flatMap(stepColumns)]);
  for (const s of spec.steps) {
    if (s.kind !== 'http') continue;
    for (const text of requestTexts(s.request)) {
      for (const m of text.matchAll(TEMPLATE_TOKEN_RE)) {
        const word = m[2];
        if (!word || own.template(word) !== undefined) continue;
        const col = columns.find(c => templateTokenIs(word, c));
        if (col) {
          return `The request of "${s.name}" has "/${word}" in it, which would read this sheet's column "${col}". `
            + 'Rename that column, then use the setup.';
        }
      }
    }
  }
  return null;
}

export function planApply(
  spec: SetupSpec, columns: string[], choices: ApplyChoices = {},
  existing: SheetColumnStep[] = [], keys: ReadonlySet<string> = new Set(),
): ApplyPlan {
  const inputs: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of spec.inputs) {
    const picked = choices.inputs?.[name];
    const col = picked !== undefined ? (columns.includes(picked) ? picked : null) : matchInput(name, columns);
    if (col === null) missing.push(name);
    else inputs[name] = col;
  }
  if (missing.length) {
    return { problem: `Pick the column of this sheet to use for ${list(missing)}.`, missing };
  }

  const map = new Map<string, string>();
  for (const [name, col] of Object.entries(inputs)) if (name !== col) map.set(name, col);
  for (const [column, raw] of Object.entries(choices.names ?? {})) {
    const step = spec.steps.find(s => stepColumns(s).includes(column));
    if (!step) return { problem: `This setup makes no column named "${column}".` };
    if (typeof raw !== 'string' || !raw.trim()) return { problem: `Give "${column}" a name.` };
    const main = column === mainColumn(step);
    const name = sanitizeAndValidateColumnName(main && step.kind === 'ai' ? raw.trim().replace(AI_SUFFIX, '') : raw);
    if ('error' in name) return { problem: `"${column}": ${name.error}` };
    if (main) {
      for (const [from, to] of stepRenames(step, name.name)) map.set(from, to);
    } else if (step.kind === 'ai' && column === `${step.name} (Data)`) {
      return { problem: `"${column}" follows its AI column's name: rename "${mainColumn(step)}" instead.` };
    } else {
      map.set(column, name.name);
    }
  }
  const fitted = remapSpec(spec, map);
  const sheetInputs = [...new Set(Object.values(inputs))];
  const out: SetupSpec = { ...fitted, inputs: sheetInputs };

  // A name a reference couldn't tell from a sheet column's (any case, or the
  // same /token) is taken, unless its step can carry that column on.
  const makes = out.steps.flatMap(stepColumns);
  const fit = fitToSheet(out, columns, existing, new Set([...keys, ...out.keys]));
  if ('problem' in fit) return fit;
  const problem = specProblem(out) ?? strayPathProblem(out, columns);
  if (problem) return { problem };
  return { ok: { spec: out, inputs, layers: specLayers(out), makes, modes: fit.modes } };
}
