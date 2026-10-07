// The treg request for one row of an enrichment (pure). Column values fill the
// input templates, then get cleaned, typed and checked against the tool's
// declared inputs, and are laid out the way treg expects (resolve.py): query
// params for GET tools, path params as query params of the same name, a JSON
// body for JSON tools. Values are encoded, never spliced into JSON text, and
// enrichments only read columns, never saved API keys.
import { createHash } from 'node:crypto';
import { normalizeColumnName } from './prompt';
import { cleanDomain, DOMAIN_INPUT_NAMES } from './enrich-input-clean';
import { TREG_TOOL_ID_PATTERN } from './constants';
import type { ToolInput } from './enrich-tool-io';

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

const TOKEN_RE = /\{\{([^}]+)\}\}/g;

// {{Column}} → that column's value in the row. `columns` is the sheet's column
// registry (column_order): stored rows are sparse, so a column the row lacks is
// an empty cell, and only a name missing from the registry is unknown. An exact
// (case-insensitive) name wins over a normalized match.
export function fillTemplate(template: string, row: Record<string, string>, columns: string[]): { value: string } | { unknown: string } {
  const miss: { name: string | null } = { name: null };
  const value = template.replace(TOKEN_RE, (_full, inner) => {
    const name = String(inner).trim();
    const lower = name.toLowerCase();
    const norm = normalizeColumnName(name);
    const col = columns.find(c => c.toLowerCase() === lower) ?? columns.find(c => normalizeColumnName(c) === norm);
    if (col === undefined) { miss.name ??= name; return ''; }
    return row[col] ?? '';
  });
  return miss.name !== null ? { unknown: miss.name } : { value };
}

const TRUE = new Set(['true', 'yes', '1', 'y']);
const FALSE = new Set(['false', 'no', '0', 'n']);

function typed(input: ToolInput, raw: string): { value: unknown } | { invalid: string } {
  const t = input.type.toLowerCase();
  if (t === 'integer' || t === 'int' || t === 'number' || t === 'float') {
    const n = Number(raw);
    if (!Number.isFinite(n) || (t.startsWith('int') && !Number.isSafeInteger(n))) return { invalid: `${input.name} must be a number, got "${raw.slice(0, 40)}".` };
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
    if (t.includes('integer') || t.includes('number')) {
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
    if (bad !== undefined) return `${input.name} must be one of ${input.enum.slice(0, 8).join(', ')} (got "${String(bad).slice(0, 40)}").`;
  }
  for (const v of values) {
    if (typeof v !== 'number') continue;
    if (input.min !== undefined && v < input.min) return `${input.name} must be at least ${input.min}.`;
    if (input.max !== undefined && v > input.max) return `${input.name} must be at most ${input.max}.`;
  }
  return null;
}

// A key is there when it was sent, or when treg can derive it from keys that
// were (contract derive: full_name from first_name + last_name, and so on).
function available(tool: RequestTool, key: string, sent: Set<string>): boolean {
  if (sent.has(key)) return true;
  const expr = tool.derive?.[key];
  if (!expr) return false;
  const refs = (expr.match(/[a-z_][a-z0-9_]*/g) ?? []).filter(r => r !== key && tool.inputs.some(i => i.name === r));
  return refs.length > 0 && refs.every(r => sent.has(r));
}

// Waterfalls need one complete identity set; single tools their required inputs.
export function missingInputs(tool: RequestTool, sent: Set<string>): string | null {
  if (tool.identitySets) {
    const ok = tool.identitySets.some(set => set.every(k => available(tool, k, sent)));
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

export function buildRequest(
  tool: RequestTool, inputMap: Record<string, string>, row: Record<string, string>,
  opts: { cleanDomains: boolean; columns: string[] },
): BuiltRequest {
  if (!TREG_TOOL_ID_PATTERN.test(tool.id)) return { ok: false, invalid: `"${tool.id.slice(0, 60)}" isn't a treg tool id.` };
  const sent: Record<string, unknown> = {};
  for (const input of tool.inputs) {
    const template = inputMap[input.name];
    if (typeof template !== 'string') continue;
    const filled = fillTemplate(template, row, opts.columns);
    if ('unknown' in filled) return { ok: false, invalid: `The column "${filled.unknown}" isn't in this sheet anymore.` };
    let raw = filled.value.trim();
    if (opts.cleanDomains && DOMAIN_INPUT_NAMES.has(input.name)) raw = cleanDomain(raw);
    if (!raw) continue;
    const t = typed(input, raw);
    if ('invalid' in t) return { ok: false, invalid: t.invalid };
    const bad = checkValue(input, t.value);
    if (bad) return { ok: false, invalid: bad };
    sent[input.name] = t.value;
  }
  const missing = missingInputs(tool, new Set(Object.keys(sent)));
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

export interface KeyParts { method: string; path: string; query: string; body: string | null; prefer?: string[]; exclude?: string[] }

// What makes two calls the same lookup. treg's idempotency fingerprint ignores
// headers, so the waterfall's provider order and skips are hashed in too.
export function requestFingerprint(p: KeyParts): string {
  return createHash('sha256')
    // prefer is an order; exclude is a set, so its order must not change the key.
    .update(JSON.stringify([p.method, p.path, p.query, p.body ?? '', p.prefer ?? [], [...(p.exclude ?? [])].sort()]))
    .digest('hex');
}

// Same run, row, attempt and request → same key → treg replays a paid answer
// for free (24 h). A rerun (new run id) or an edited cell (new hash) is a new
// call. Well under treg's 200-character limit.
export function idempotencyKey(runId: string, rowIndex: number, attempt: string, parts: KeyParts): string {
  return `cbx1:${runId}:${rowIndex}:${attempt}:${requestFingerprint(parts).slice(0, 32)}`;
}
