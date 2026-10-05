// Pure helpers for structured multi-column AI output. No DB, no network — the
// runner supplies the raw model text and the column spec, and gets back either
// coerced per-column string values or a parse error (→ status column ❌). Kept
// pure so every edge (fenced JSON, missing keys, junk types) is unit-testable.

export type OutputColumnType = 'string' | 'number' | 'boolean';

export interface OutputColumnSpec {
  columnName: string;
  type: OutputColumnType;
  description: string;
}

// Reserved key a structured run with a web tool adds to its JSON: the URLs the
// model used. Fetched pages come back with no citations of their own, so this
// is how a fetch-only run fills its "(Data)" column. No output column may take
// this name (ai-run-parse.ts).
export const SOURCES_KEY = '__sources';
const MAX_SOURCE_URLS = 20;
const MAX_SOURCE_URL_LENGTH = 2000;

// Instruction appended to the row prompt: return ONE JSON object with exactly the
// requested keys. Deterministically derived from the spec (and, for a run with a
// web tool, withSources) so a resume rebuilds the identical instruction (risk B7).
export function buildMultiOutputInstruction(specs: OutputColumnSpec[], opts: { withSources?: boolean } = {}): string {
  const lines = specs.map(s => `- ${JSON.stringify(s.columnName)} (${s.type}): ${s.description}`);
  if (opts.withSources) {
    lines.push(`- ${JSON.stringify(SOURCES_KEY)} (array of strings): the full URLs of the web pages you used, fetched or found by search; [] if none`);
  }
  return [
    'Respond with ONLY a single JSON object — no markdown fences, no commentary before or after.',
    'The object must contain EXACTLY these keys, each holding a value of the stated type:',
    ...lines,
    'If a value cannot be determined, use null. Output valid JSON only.',
  ].join('\n');
}

// Strip a leading/trailing ```json ... ``` (or bare ```) fence models often add
// despite instructions. Returns the inner text, trimmed.
function stripCodeFence(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(t);
  return fence ? fence[1].trim() : t;
}

// Coerce ONE parsed JSON value to its declared type, as the canonical STRING we
// store (rows.data is uniformly string-valued; sort + where already parse numeric
// strings — see lib/sql-helpers compareSortValues). A value that can't be
// coerced (null, wrong shape, non-numeric for number) becomes '' (blank cell),
// never a row failure — only whole-object parse failure fails the row.
export function coerceOutputValue(raw: unknown, type: OutputColumnType): string {
  if (raw === null || raw === undefined) return '';
  if (type === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
    if (typeof raw === 'string') {
      const t = raw.trim();
      return t !== '' && Number.isFinite(Number(t)) ? t : '';
    }
    return '';
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw ? 'true' : 'false';
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(t)) return 'true';
      if (['false', 'no', '0'].includes(t)) return 'false';
    }
    return '';
  }
  // string
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw); // object/array → serialize rather than drop
}

export type MultiOutputResult =
  | { ok: Record<string, string> }
  | { error: string };

// The reply (fence already stripped) as a JSON value. Models, especially with
// web tools, sometimes wrap the object in a sentence ("Here is the result: {…}")
// or add a note after the fence; when the whole reply isn't JSON, the span from
// the first "{" to the last "}" is tried before giving up. Throws if neither parses.
function parseReplyJson(inner: string): unknown {
  try {
    return JSON.parse(inner);
  } catch (error) {
    const start = inner.indexOf('{');
    const end = inner.lastIndexOf('}');
    if (start === -1 || end <= start) throw error;
    return JSON.parse(inner.slice(start, end + 1));
  }
}

// Parse the model's text into a JSON object and coerce each declared column.
// Whole-object parse failure (not JSON / not an object) → { error } → the runner
// writes ❌ to the status column. Missing keys coerce to '' (blank), NOT an error.
export function parseMultiOutput(rawText: string, specs: OutputColumnSpec[]): MultiOutputResult {
  const inner = stripCodeFence(rawText ?? '');
  if (inner === '') return { error: 'Model returned empty output' };
  let parsed: unknown;
  try {
    parsed = parseReplyJson(inner);
  } catch {
    // Quote the start of the reply so a failed row says what went wrong.
    const began = inner.replace(/\s+/g, ' ').slice(0, 80);
    return { error: `Model did not return valid JSON (its reply began: "${began}")` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Model output was not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const spec of specs) out[spec.columnName] = coerceOutputValue(obj[spec.columnName], spec.type);
  return { ok: out };
}

// The http(s) URLs under SOURCES_KEY in the model's JSON, deduplicated and
// capped. Anything else (missing key, not JSON, junk entries) gives [] rather
// than failing the row: the sources are a bonus, the typed columns the answer.
export function sourcesFromOutput(rawText: string): string[] {
  let obj: unknown;
  try { obj = parseReplyJson(stripCodeFence(rawText ?? '')); } catch { return []; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const raw = (obj as Record<string, unknown>)[SOURCES_KEY];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const urls: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const url = item.trim();
    if (url.length > MAX_SOURCE_URL_LENGTH || !/^https?:\/\/[^\s]+$/i.test(url) || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length === MAX_SOURCE_URLS) break;
  }
  return urls;
}
