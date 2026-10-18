// A waterfall's inputs (pure). Each input key maps once to a sheet column,
// written "{{Column}}", or to a fixed value; every step reads the inputs,
// never a column. The map is kept in the run's requestConfig.body, like an
// enrichment's input templates, so a column rename rewrites it and a delete
// records the column in requestConfig.goneColumns (lib/http-columns.ts) with
// every other HTTP run's request: an input whose column is gone reads empty.
import { COLUMN_REF_PATTERN, normalizeColumnName } from '../prompt';
import { holdsRunMarker, trimBlank } from '../run-markers';
import { goneColumnsOf } from '../template-token-match';
import { inputTemplates } from '../enrich-run-config';
import type { HTTPAPIConfig } from '../http-request-template';

export const INPUT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const COLUMN_TEMPLATE = /^\{\{(.+)\}\}$/s;
// The prompt's /column token rule, without the shared pattern's global state.
const SLASH_REF = new RegExp(COLUMN_REF_PATTERN.source);

export type InputSource = { column: string } | { value: string };

// The column a template reads, or null for a fixed value.
export function templateColumn(template: string): string | null {
  const m = COLUMN_TEMPLATE.exec(template);
  return m ? m[1] : null;
}

// How a source is stored: "{{Column}}" or the value as given.
export const templateOf = (s: InputSource): string => ('column' in s ? `{{${s.column}}}` : s.value);

// Why a fixed value can't be kept, or null: braces would read as a column, and
// a /word could be taken for a column reference when one is renamed.
export function fixedValueProblem(value: string): string | null {
  if (value.includes('{{') || value.includes('}}')) return 'A fixed value can\'t hold "{{" or "}}".';
  if (SLASH_REF.test(value)) return 'A fixed value can\'t hold a /word (write it without the slash).';
  return null;
}

// The input map of a run's config: {key: template}.
export function inputMapOf(config: HTTPAPIConfig): Record<string, string> {
  return inputTemplates(config);
}

// The source of each input, for recall (a column gone since reads as unmapped).
export function inputSourcesOf(config: HTTPAPIConfig): Record<string, InputSource | null> {
  const gone = new Set(goneColumnsOf(config.requestConfig));
  const out: Record<string, InputSource | null> = {};
  for (const [key, template] of Object.entries(inputMapOf(config))) {
    const column = templateColumn(template);
    out[key] = column === null ? { value: template } : gone.has(column) ? null : { column };
  }
  return out;
}

// The sheet column a template's name reads, as an enrichment input reads it
// (lib/enrich-request.ts fillTemplate): the exact name, then the same name in
// another case, then the normalized name (a rename to a name holding "}"
// writes that form), or null when the sheet has no such column.
export function resolveColumn(name: string, columns: readonly string[]): string | null {
  if (columns.includes(name)) return name;
  const lower = name.trim().toLowerCase();
  const norm = normalizeColumnName(name);
  return columns.find(c => c.toLowerCase() === lower) ?? columns.find(c => normalizeColumnName(c) === norm) ?? null;
}

// One row's input values: a column's cell (a run's own words read as empty,
// blank edges trimmed), a fixed value as given, '' for anything unmapped or
// whose column is gone. `columns`: the sheet's column registry.
export function inputValues(
  map: Record<string, string>, row: Record<string, string>, gone: readonly string[], keys: readonly string[],
  columns: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const template = map[key];
    if (template === undefined) { out[key] = ''; continue; }
    const named = templateColumn(template);
    if (named === null) { out[key] = template; continue; }
    const column = gone.includes(named) ? null : resolveColumn(named, columns);
    const cell = column === null ? '' : row[column];
    const v = typeof cell === 'string' ? trimBlank(cell) : cell === undefined || cell === null ? '' : String(cell);
    out[key] = holdsRunMarker(v) ? '' : v;
  }
  return out;
}

// Whether a row has every input of at least one alternative (none listed: always).
export function requiresMet(requires: readonly string[][], inputs: Record<string, string>): boolean {
  if (requires.length === 0) return true;
  return requires.some(alt => alt.every(key => (inputs[key] ?? '') !== ''));
}

// "first_name + last_name + domain, or linkedin_url" for messages.
export function requiresText(requires: readonly string[][]): string {
  return requires.map(alt => alt.join(' + ')).join(', or ');
}
