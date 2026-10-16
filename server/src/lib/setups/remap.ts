// Renaming columns throughout a setup (pure): its inputs to the columns of
// the sheet it's used on, and the columns its steps make to names that sheet
// doesn't have yet; saving also uses it to give a renamed AI column back the
// name its run makes. Every reference is renamed in ONE pass through the
// map, so swapping two names, or renaming A to B and B to C, can't collide.
// Each reference is matched by its own run's rule (refs.ts), the way a
// column rename rewrites them (lib/column-ref-rename.ts); a saved key's name
// is never a column, so its tokens are left alone.
import { COLUMN_REF_PATTERN, normalizeColumnName } from '../prompt';
import { TEMPLATE_TOKEN_RE } from '../http-request-template';
import { resolveColumnRef } from '../column-ref-resolve';
import { renameRuleColumns } from '../run-condition';
import { FormulaScan } from '../formula/scan';
import { formulaRefProblem } from '../formula/refs';
import { columnLookup } from './refs';
import { stepColumns, type AutoRunSpec, type SetupSpec, type SetupStep } from './spec';

// Old column name (exactly) → new name.
export type NameMap = ReadonlyMap<string, string>;

const AI_SUFFIX = { single: ' (Output)', structured: ' (Status)' } as const;

function remapper(map: NameMap, known: string[]) {
  const find = columnLookup(known);
  const exact = (c: string) => map.get(c) ?? c;
  const resolved = (name: string) => {
    const col = known.includes(name) ? name : resolveColumnRef(name, known);
    return col !== null && map.has(col) ? map.get(col)! : undefined;
  };
  const prompt = (text: string) => text.replace(COLUMN_REF_PATTERN, (full, token: string) => {
    const col = find.prompt(token);
    return col !== undefined && map.has(col) ? `/${normalizeColumnName(map.get(col)!)}` : full;
  });
  const template = (text: string) => text.replace(TEMPLATE_TOKEN_RE,
    (full, braceInner: string | undefined, slashName: string | undefined) => {
      const token = braceInner !== undefined ? braceInner.trim() : slashName;
      const col = token ? find.template(token) : undefined;
      if (col === undefined || !map.has(col)) return full;
      const next = map.get(col)!;
      if (braceInner !== undefined) return `{{${/[{}]/.test(next) ? normalizeColumnName(next) : next}}}`;
      return `/${normalizeColumnName(next)}`;
    });
  const rule = (text: string | null) => (text ? renameRuleColumns(text, resolved) : text);
  const formula = (text: string) => {
    try {
      // A name a formula can't read ("}}" in it) stays as it was: the formula column's start says so.
      return new FormulaScan(text, name => {
        const next = resolved(name);
        return next === undefined || formulaRefProblem(next) ? null : { raw: `{{${next}}}` };
      }).run().out;
    } catch {
      return text;
    }
  };
  const autoRun = (a: AutoRunSpec | null) => (a ? { ...a, runIf: rule(a.runIf) } : a);
  return { exact, resolved, prompt, template, rule, formula, autoRun, find };
}

export function remapStep(s: SetupStep, map: NameMap, known: string[]): SetupStep {
  const r = remapper(map, known);
  switch (s.kind) {
    case 'ai': {
      const structured = !!s.outputColumns?.length;
      const suffix = structured ? AI_SUFFIX.structured : AI_SUFFIX.single;
      const main = `${s.name}${suffix}`;
      const nextMain = map.get(main);
      const name = nextMain === undefined ? s.name
        : nextMain.endsWith(suffix) ? nextMain.slice(0, -suffix.length) : nextMain;
      return {
        ...s, name, prompt: r.prompt(s.prompt), runIf: r.rule(s.runIf),
        outputColumns: s.outputColumns?.map(o => ({ ...o, columnName: r.exact(o.columnName) })) ?? null,
      };
    }
    case 'http': {
      const headers: Record<string, string> = Object.fromEntries(
        Object.entries(s.request.headers).map(([h, v]) => [r.template(h), r.template(v)]));
      return {
        ...s, name: r.exact(s.name), runIf: r.rule(s.runIf), autoRun: r.autoRun(s.autoRun),
        request: {
          ...s.request, url: r.template(s.request.url), headers,
          body: s.request.body === null ? null : r.template(s.request.body),
        },
        mappings: s.mappings.map(m => ({ ...m, columnName: r.exact(m.columnName) })),
      };
    }
    case 'enrichment': {
      const inputs: typeof s.inputs = Object.fromEntries(Object.entries(s.inputs).map(([k, b]) => {
        const col = 'column' in b ? r.find.template(b.column) : undefined;
        return [k, col !== undefined && map.has(col) ? { column: map.get(col)! } : b];
      }));
      return {
        ...s, name: r.exact(s.name), inputs, runIf: r.rule(s.runIf), autoRun: r.autoRun(s.autoRun),
        conditions: s.conditions.map(c => ({ ...c, column: r.resolved(c.column) ?? c.column })),
        outputs: s.outputs.map(o => ({ ...o, columnName: r.exact(o.columnName) })),
      };
    }
    case 'clean':
      return { ...s, name: r.exact(s.name), source: r.resolved(s.source) ?? s.source };
    case 'formula':
      return { ...s, name: r.exact(s.name), formula: r.formula(s.formula) };
  }
}

// Every name the setup knows: its inputs and every column its steps make.
export const specColumns = (spec: SetupSpec): string[] => [...spec.inputs, ...spec.steps.flatMap(stepColumns)];

// An AI step's columns all follow its base name: renaming its main column
// ("Score (Output)" to "Fit (Output)", or just "Fit") renames the base, so its
// Output, Status and Data columns, and every reference to them, move together.
function withAiRenames(spec: SetupSpec, map: NameMap): Map<string, string> {
  const out = new Map(map);
  for (const s of spec.steps) {
    if (s.kind !== 'ai') continue;
    const main = stepColumns(s)[0];
    const next = map.get(main);
    if (next === undefined) continue;
    const suffix = s.outputColumns?.length ? AI_SUFFIX.structured : AI_SUFFIX.single;
    const base = next.endsWith(suffix) ? next.slice(0, -suffix.length) : next;
    for (const [from, to] of stepRenames(s, base)) if (from === main || !map.has(from)) out.set(from, to);
  }
  return out;
}

export function remapSpec(spec: SetupSpec, map: NameMap): SetupSpec {
  const known = specColumns(spec);
  const full = withAiRenames(spec, map);
  return {
    ...spec,
    inputs: spec.inputs.map(c => full.get(c) ?? c),
    steps: spec.steps.map(s => remapStep(s, full, known)),
  };
}

// The renames that give a step a new main name: for an AI step every column
// its base name makes (Output, Status, Data); for the others the main column.
export function stepRenames(s: SetupStep, newName: string): Array<[string, string]> {
  if (s.kind !== 'ai') return [[s.name, newName]];
  const next = { ...s, name: newName };
  const from = stepColumns(s), to = stepColumns(next);
  return from.map((c, i) => [c, to[i]] as [string, string]).filter(([a, b]) => a !== b);
}
