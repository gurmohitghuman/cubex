// What a setup step reads (pure): the columns and saved keys its prompt,
// request, formula, source, inputs and rules name, each resolved the way its
// own run resolves it at run time, against `known` (the sheet's columns when
// saving; the setup's inputs and the columns of the steps before it when
// checking a setup). A name that resolves to nothing is a problem, said in
// words: a saved setup never holds a reference its run would fill with
// "[MISSING: …]".
import { extractColumnReferences, normalizeColumnName } from '../prompt';
import { TEMPLATE_TOKEN_RE } from '../http-request-template';
import { resolveColumnRef } from '../column-ref-resolve';
import { checkRule, RuleError } from '../run-condition';
import { compileFormula, FormulaError } from '../formula/refs';
import type { SetupStep } from './spec';

export interface StepReads { columns: string[]; keys: string[]; problems: string[] }

// The columns a token names, looked up in maps built once per check (a setup
// can hold thousands of tokens): by name ignoring case, else by normalized name.
// prompt: an AI prompt's /token (lib/prompt.ts processPromptTemplate's rule).
// template: a request's {{name}} or /name (templateTokenIs' rule), which a
// column wins over a saved key of that exact name.
export function columnLookup(known: string[]) {
  const lower = new Map<string, string>(), norm = new Map<string, string>();
  for (const c of known) {
    if (!lower.has(c.toLowerCase())) lower.set(c.toLowerCase(), c);
    if (!norm.has(normalizeColumnName(c))) norm.set(normalizeColumnName(c), c);
  }
  return {
    prompt: (token: string) => lower.get(token.toLowerCase()) ?? norm.get(token),
    template: (token: string) => lower.get(token.toLowerCase()) ?? norm.get(normalizeColumnName(token)),
  };
}

export const promptTokenColumn = (token: string, known: string[]): string | undefined =>
  columnLookup(known).prompt(token);
export const templateTokenColumn = (token: string, known: string[]): string | undefined =>
  columnLookup(known).template(token);

export function requestTexts(r: { url: string; headers: Record<string, string>; body: string | null }): string[] {
  return [r.url, ...Object.entries(r.headers).flat(), ...(r.body ? [r.body] : [])];
}

export function stepReads(s: SetupStep, known: string[], keys: ReadonlySet<string>): StepReads {
  const columns = new Set<string>(), keyNames = new Set<string>(), problems: string[] = [];
  const find = columnLookup(known);
  const rule = (text: string | null | undefined, what = '"Only run if"') => {
    if (!text) return;
    try {
      for (const c of checkRule(text, known).columns) columns.add(c);
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      problems.push(`${what}: ${e.message}`);
    }
  };
  const column = (name: string, how: string) => {
    const col = known.includes(name) ? name : resolveColumnRef(name, known);
    if (col) columns.add(col);
    else problems.push(`${how} reads "${name}", which isn't a column.`);
  };
  // A {{name}} must resolve; a /name that resolves to nothing is plain text at
  // run time (a path such as "/search"), as the run start's check has it.
  const template = (text: string) => {
    for (const m of text.matchAll(TEMPLATE_TOKEN_RE)) {
      const token = m[1] !== undefined ? m[1].trim() : m[2];
      if (!token) continue;
      const col = find.template(token);
      if (col) columns.add(col);
      else if (keys.has(token)) keyNames.add(token);
      else if (m[1] !== undefined) {
        problems.push(`The request reads {{${token}}}, which is neither a column nor a saved key.`);
      }
    }
  };

  switch (s.kind) {
    case 'ai':
      for (const token of extractColumnReferences(s.prompt)) {
        const col = find.prompt(token);
        if (col) columns.add(col);
        else problems.push(`The prompt reads /${token}, which isn't a column.`);
      }
      rule(s.runIf);
      break;
    case 'http':
      requestTexts(s.request).forEach(template);
      rule(s.runIf);
      rule(s.autoRun?.runIf, 'Auto-run\'s "Only run if"');
      break;
    case 'enrichment':
      for (const b of Object.values(s.inputs)) {
        if (!('column' in b)) continue;
        const col = find.template(b.column);
        if (col) columns.add(col);
        else problems.push(`An input reads "${b.column}", which isn't a column.`);
      }
      for (const c of s.conditions) column(c.column, 'A condition');
      rule(s.runIf);
      rule(s.autoRun?.runIf, 'Auto-run\'s "Only run if"');
      break;
    case 'clean':
      column(s.source, 'The cleaner');
      break;
    case 'formula':
      try {
        for (const c of compileFormula(s.formula, known).inputs) columns.add(c);
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e;
        problems.push(`The formula: ${e.message}`);
      }
      break;
  }
  return { columns: [...columns], keys: [...keyNames], problems };
}
