// A setup used on a sheet that has some of its columns already (pure): a step
// whose main column is here, made the same way, carries that column on
// ('again': it fills only the rows it hasn't done, with the column's own
// settings) instead of being refused as taken. That's how a setup fills new
// rows, or carries on after it failed or was stopped. Made the same way: the
// same kind of column, making the same columns (each still in the sheet, but
// an AI step's "(Data)" column, which its rerun makes again), reading the same
// columns and saved keys, and set up alike (settingsOf: what decides each
// value, such as the prompt, the request and its fields, the enrichment tool,
// the cleaner, the formula; not how fast or on which model, its rule or its
// auto-run, which are the column's own). Any other name the sheet has
// already is taken, as before.
import { findColumnNameCollision } from '../column-names';
import { stepReads } from './refs';
import { KIND_LABEL, mainColumn, stepColumns, type SetupSpec, type SetupStep, type StepKind } from './spec';

export type StepMode = 'new' | 'again';

// A filled column of the sheet as services/setup-steps.ts reads it: its kind,
// the columns it made as the sheet lists them (main first), and its settings
// as a step (null when it can't be one, as a list enrichment can't).
export interface SheetColumnStep { kind: StepKind; columns: string[]; step: SetupStep | null }

export type SheetFit = { modes: StepMode[] } | { problem: string; taken: string[] };

const list = (names: string[]) => names.map(n => `"${n}"`).join(', ');
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

// A stable JSON text: object keys sorted, so key order never reads as a difference.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// What decides a step's values, by part, to say which one differs.
function settingsOf(s: SetupStep): Record<string, unknown> {
  switch (s.kind) {
    case 'ai': return {
      prompt: [s.prompt.trim(), (s.systemPrompt ?? '').trim()], 'output columns': s.outputColumns ?? [],
      'web tools': [s.webSearch, s.webFetch],
    };
    case 'http': return {
      request: [s.request.method, s.request.url.trim(), s.request.headers, (s.request.body ?? '').trim()],
      fields: s.mappings.map(m => [m.jsonPath, m.columnName]),
    };
    case 'enrichment': return {
      job: [s.toolId, s.preset, s.cleanDomains], inputs: s.inputs, fields: s.outputs.map(o => [o.key, o.columnName]),
    };
    case 'clean': return { cleaner: [s.cleaner, s.options] };
    case 'formula': return { formula: s.formula.trim() };
  }
}

function settingsDiffer(a: SetupStep, b: SetupStep): string | null {
  const x = settingsOf(a), y = settingsOf(b);
  return Object.keys(x).find(part => stable(x[part]) !== stable(y[part])) ?? null;
}

function readsOf(s: SetupStep, known: string[], keys: ReadonlySet<string>) {
  const run = s.kind === 'http' || s.kind === 'enrichment' ? { ...s, autoRun: null } : s;
  const r = stepReads(run, known, keys);
  return { columns: r.columns, keys: r.keys };
}

// Why the sheet's column can't carry `step` on, in a sentence; null when it can.
function againProblem(
  step: SetupStep, known: string[], col: SheetColumnStep, sheetColumns: string[], keys: ReadonlySet<string>,
): string | null {
  const main = mainColumn(step);
  if (col.kind !== step.kind) return `"${main}" here is a ${KIND_LABEL[col.kind]} column.`;
  if (!col.step) return `"${main}" here can't be carried on by a setup.`;
  const want = stepColumns(step), have = stepColumns(col.step);
  if (!sameSet(want, have)) return `"${main}" here makes other columns (${list(have)}).`;
  const data = step.kind === 'ai' ? `${step.name} (Data)` : null;
  const gone = want.find(c => c !== data && !sheetColumns.includes(c));
  if (gone) return `"${gone}" of "${main}" isn't in this sheet anymore.`;
  if (step.kind === 'enrichment' && col.step.kind === 'enrichment' && step.toolId !== col.step.toolId) {
    return `"${main}" here runs another enrichment (${col.step.toolName}).`;
  }
  const a = readsOf(step, known, keys), b = readsOf(col.step, sheetColumns, keys);
  if (!sameSet(a.columns, b.columns) || !sameSet(a.keys, b.keys)) {
    return `"${main}" here reads other columns (${list([...b.columns, ...b.keys]) || 'none'}).`;
  }
  const part = settingsDiffer(step, col.step);
  return part ? `"${main}" here is set up differently from this setup (its ${part}).` : null;
}

// Each step of a setup fitted to the sheet (apply-plan.ts): new, or carrying
// on the sheet's column; or the names the sheet has that no step can carry on.
export function fitToSheet(
  spec: SetupSpec, sheetColumns: string[], have: SheetColumnStep[], keys: ReadonlySet<string>,
): SheetFit {
  const byMain = new Map(have.filter(c => c.columns.length).map(c => [c.columns[0], c]));
  const known = [...spec.inputs, ...spec.steps.flatMap(stepColumns)];
  const modes: StepMode[] = [], taken: string[] = [], why: string[] = [];
  for (const s of spec.steps) {
    const clashes = stepColumns(s).filter(c => findColumnNameCollision(c, sheetColumns) !== null);
    modes.push('new');
    if (!clashes.length) continue;
    const col = byMain.get(mainColumn(s));
    const problem = col ? againProblem(s, known, col, sheetColumns, keys) : null;
    if (col && !problem) { modes[modes.length - 1] = 'again'; continue; }
    taken.push(...clashes);
    if (problem) why.push(problem);
  }
  if (!taken.length) return { modes };
  return {
    taken,
    problem: `This sheet already has ${taken.length === 1 ? 'a column named' : 'columns named'} ${list(taken)}. `
      + (why.length ? `${why[0]} ` : '') + 'Give those steps other names.',
  };
}
