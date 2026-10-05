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

// Instruction appended to the row prompt: return ONE JSON object with exactly the
// requested keys. Deterministically derived from the spec so a resume rebuilds
// the identical instruction (risk B7).
export function buildMultiOutputInstruction(specs: OutputColumnSpec[]): string {
  const lines = specs.map(s => `- ${JSON.stringify(s.columnName)} (${s.type}): ${s.description}`);
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

// Parse the model's text into a JSON object and coerce each declared column.
// Whole-object parse failure (not JSON / not an object) → { error } → the runner
// writes ❌ to the status column. Missing keys coerce to '' (blank), NOT an error.
export function parseMultiOutput(rawText: string, specs: OutputColumnSpec[]): MultiOutputResult {
  const inner = stripCodeFence(rawText ?? '');
  if (inner === '') return { error: 'Model returned empty output' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return { error: 'Model did not return valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Model output was not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const spec of specs) out[spec.columnName] = coerceOutputValue(obj[spec.columnName], spec.type);
  return { ok: out };
}
