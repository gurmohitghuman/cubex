// Over 200 lines: one request built from a row, every input filled, checked and laid out in one pass.
// The treg request for one row of an enrichment (pure). Column values fill the
// input templates, then get cleaned, typed and checked against the tool's
// declared inputs, and are laid out the way treg expects (resolve.py): query
// params for GET tools, path params as query params of the same name, a JSON
// body for JSON tools. Values are encoded, never spliced into JSON text, and
// enrichments only read columns, never saved API keys. A list or object input
// whose template is laid out as JSON is filled item by item (lib/enrich-template.ts).
import { createHash } from 'node:crypto';
import { fillJsonTemplate, fillTemplate, jsonTemplateOf } from './enrich-template';
import { cleanDomain, DOMAIN_INPUT_NAMES } from './enrich-input-clean';
import { setAvailable } from './enrich-accepts';
import { TREG_TOOL_ID_PATTERN } from './constants';
import type { ToolInput } from './enrich-tool-io';
import { hiringTitleMissing } from './hiring/title-words';

export interface RequestTool {
  id: string;
  method: string;
  inputs: ToolInput[];
  identitySets: string[][] | null;
  derive: Record<string, string> | null;
  queryArrayEncoding: string | null;
}

export type BuiltRequest =
  | { ok: true; method: string; path: string; query: string; body: string | null; sent: Record<string, unknown> }
  | { ok: false; missing: string }   // required inputs are empty: skip the row, no call
  | { ok: false; invalid: string };  // a value can't be sent as the tool declares it

const TRUE = new Set(['true', 'yes', '1', 'y']);
const FALSE = new Set(['false', 'no', '0', 'n']);

// The old words too (int, float, bool, list, dict): a run set up before keeps its tool's inputs as they were then.
function typed(input: ToolInput, raw: string): { value: unknown } | { invalid: string } {
  const t = input.type.toLowerCase();
  if (t === 'integer' || t === 'int' || t === 'number' || t === 'float') {
    const n = Number(raw);
    if (!Number.isFinite(n) || (t.startsWith('int') && !Number.isSafeInteger(n))) {
      return { invalid: `${input.name} must be a number, got "${raw.slice(0, 40)}".` };
    }
    return { value: n };
  }
  if (t === 'boolean' || t === 'bool') {
    const v = raw.toLowerCase();
    if (TRUE.has(v)) return { value: true };
    if (FALSE.has(v)) return { value: false };
    return { invalid: `${input.name} must be true or false, got "${raw.slice(0, 40)}".` };
  }
  if (t.startsWith('array') || t === 'list' || (t === 'string_or_array' && raw.startsWith('['))) {
    let items: unknown[];
    if (raw.startsWith('[')) {
      try { const parsed = JSON.parse(raw); items = Array.isArray(parsed) ? parsed : [parsed]; }
      catch { return { invalid: `${input.name} looks like a list but isn't valid JSON.` }; }
    } else {
      items = raw.split(',').map(s => s.trim()).filter(Boolean);
    }
    // Numbers only when the items are numbers alone: a list that may hold text, or lists, goes as written.
    if (/^array\[(integer|number)\]$/.test(t)) {
      const nums = items.map(Number);
      if (nums.some(n => !Number.isFinite(n))) return { invalid: `${input.name} must be a list of numbers.` };
      return { value: nums };
    }
    return { value: items };
  }
  if (t === 'object' || t === 'dict') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed };
    } catch { /* fall through */ }
    return { invalid: `${input.name} must be a JSON object.` };
  }
  return { value: raw };
}

function checkValue(input: ToolInput, value: unknown): string | null {
  const values = Array.isArray(value) ? value : [value];
  if (input.enum && input.enum.length) {
    const allowed = new Set(input.enum.map(String));
    const bad = values.find(v => !allowed.has(String(v)));
    if (bad !== undefined) {
      return `${input.name} must be one of ${input.enum.slice(0, 8).join(', ')} (got "${String(bad).slice(0, 40)}").`;
    }
  }
  for (const v of values) {
    if (typeof v !== 'number') continue;
    if (input.min !== undefined && v < input.min) return `${input.name} must be at least ${input.min}.`;
    if (input.max !== undefined && v > input.max) return `${input.name} must be at most ${input.max}.`;
  }
  return null;
}

// A list or object input with a JSON template: its value for the row (undefined:
// nothing to send), checked as a typed one is. null: not such an input.
function jsonInput(input: ToolInput, template: string, row: Record<string, string>, columns: string[]):
  { value: unknown } | { invalid: string } | null {
  const t = input.type.toLowerCase();
  const list = (t.startsWith('array') && !/^array\[(integer|number)\]$/.test(t)) || t === 'list'
    || t === 'string_or_array';
  const json = list || t === 'object' || t === 'dict' ? jsonTemplateOf(template) : null;
  if (!json) return null;
  const filled = fillJsonTemplate(json, row, columns);
  if ('unknown' in filled) return { invalid: `The column "${filled.unknown}" isn't in this sheet anymore.` };
  if (filled.value === undefined) return { value: undefined };
  const value = list && !Array.isArray(filled.value) ? [filled.value] : filled.value;
  if (!list && Array.isArray(value)) return { invalid: `${input.name} must be a JSON object.` };
  const bad = checkValue(input, value);
  return bad ? { invalid: bad } : { value };
}

// Waterfalls need one complete identity set (counting what treg derives, such
// as full_name from first_name + last_name); single tools their required inputs.
export function missingInputs(tool: RequestTool, sent: Set<string>): string | null {
  if (tool.identitySets) {
    const known = new Set(tool.inputs.map(i => i.name));
    const ok = tool.identitySets.some(set => setAvailable(set, sent, tool.derive, known));
    if (!ok) return tool.identitySets.map(s => s.join(' + ')).join(', or ');
  }
  const required = tool.inputs.filter(i => i.required && !sent.has(i.name)).map(i => i.name);
  return required.length ? required.join(', ') : null;
}

function appendQuery(query: Array<[string, string]>, name: string, value: unknown, encoding: string | null): void {
  if (!Array.isArray(value)) { query.push([name, typeof value === 'string' ? value : JSON.stringify(value)]); return; }
  if (encoding === 'json') query.push([name, JSON.stringify(value)]);
  else if (encoding === 'comma') query.push([name, value.map(String).join(',')]);
  else for (const v of value) query.push([name, String(v)]);
}

// A list of company domains (a job search at those companies, services/open-roles.ts) under a run's domain cleaning:
// each item cleaned as a domain input is, empty ones left out. One that read a column and came out empty is missing,
// so the row isn't searched: with no company, the search would answer roles at any company.
const DOMAIN_LIST_INPUT_NAMES = new Set(['company_domains']);
const TOKEN_IN = /\{\{[^{}]+\}\}/;
function cleanDomainList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const kept = value.map(v => (typeof v === 'string' ? cleanDomain(v) : v)).filter(v => v !== '');
  return kept.length ? kept : undefined;
}

export function buildRequest(
  tool: RequestTool, inputMap: Record<string, string>, row: Record<string, string>,
  opts: { cleanDomains: boolean; columns: string[] },
): BuiltRequest {
  if (!TREG_TOOL_ID_PATTERN.test(tool.id)) {
    return { ok: false, invalid: `"${tool.id.slice(0, 60)}" isn't a treg tool id.` };
  }
  const sent: Record<string, unknown> = {};
  const noCompany: string[] = [];
  for (const input of tool.inputs) {
    const template = inputMap[input.name];
    if (typeof template !== 'string') continue;
    const json = jsonInput(input, template, row, opts.columns);
    if (json && 'invalid' in json) return { ok: false, invalid: json.invalid };
    if (json) {
      const companies = opts.cleanDomains && DOMAIN_LIST_INPUT_NAMES.has(input.name);
      const value = companies ? cleanDomainList(json.value) : json.value;
      if (value !== undefined) sent[input.name] = value;
      else if (companies && TOKEN_IN.test(template)) noCompany.push(input.name);
      continue;
    }
    const filled = fillTemplate(template, row, opts.columns);
    if ('unknown' in filled) {
      return { ok: false, invalid: `The column "${filled.unknown}" isn't in this sheet anymore.` };
    }
    let raw = filled.value.trim();
    if (opts.cleanDomains && DOMAIN_INPUT_NAMES.has(input.name)) raw = cleanDomain(raw);
    const companies = opts.cleanDomains && DOMAIN_LIST_INPUT_NAMES.has(input.name) && TOKEN_IN.test(template);
    if (!raw) {
      if (companies) noCompany.push(input.name);
      continue;
    }
    const t = typed(input, raw);
    if ('invalid' in t) return { ok: false, invalid: t.invalid };
    const bad = checkValue(input, t.value);
    if (bad) return { ok: false, invalid: bad };
    const value = companies ? cleanDomainList(t.value) : t.value;
    if (value === undefined) noCompany.push(input.name);
    else sent[input.name] = value;
  }
  // A hiring search whose role title has no word to search for would answer any role: missing, as an empty one.
  const missing = missingInputs(tool, new Set(Object.keys(sent))) ?? hiringTitleMissing(tool.id, inputMap, sent)
    ?? (noCompany.length ? noCompany.join(', ') : null);
  if (missing) return { ok: false, missing };

  const method = tool.method.toUpperCase();
  const jsonBody = !['GET', 'HEAD', 'DELETE'].includes(method);
  const query: Array<[string, string]> = [];
  const body: Record<string, unknown> = {};
  for (const input of tool.inputs) {
    if (!(input.name in sent)) continue;
    if (jsonBody && input.in === 'body') body[input.name] = sent[input.name];
    else appendQuery(query, input.name, sent[input.name], tool.queryArrayEncoding);
  }
  return {
    ok: true, method, path: `/call/${encodeURIComponent(tool.id)}`,
    query: query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
    body: jsonBody ? JSON.stringify(body) : null,
    sent,
  };
}

export interface KeyParts {
  method: string; path: string; query: string; body: string | null; prefer?: string[]; exclude?: string[];
}

// What makes two calls the same lookup. treg's idempotency fingerprint ignores
// headers, so the waterfall's provider order and skips are hashed in too.
export function requestFingerprint(p: KeyParts): string {
  return createHash('sha256')
    // prefer is an order; exclude is a set, so its order must not change the key.
    .update(JSON.stringify([p.method, p.path, p.query, p.body ?? '', p.prefer ?? [], [...(p.exclude ?? [])].sort()]))
    .digest('hex');
}

// Same scope, row, attempt and request → same key → treg replays a paid answer
// for free (24 h). A run's scope is its id and the row its position, so a rerun
// (new run id) or an edited cell (new hash) is a new call. An auto-run's scope
// is its entry and the row its id (services/enrich-step.ts keyScope). Well
// under treg's 200-character limit.
export const keyPrefix = (scope: string, row: number | string): string => `cbx1:${scope}:${row}:`;

export function idempotencyKey(scope: string, row: number | string, attempt: string, parts: KeyParts): string {
  return `${keyPrefix(scope, row)}${attempt}:${requestFingerprint(parts).slice(0, 32)}`;
}
