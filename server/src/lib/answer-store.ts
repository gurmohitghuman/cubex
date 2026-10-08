// The shape of a stored answer (http_results.response_data of an enrichment
// row), pure. Next to treg's answer it carries Cubex's own notes under keys
// that start with "$": `$trimmedPaths` (parts too big to keep, answer-trim.ts),
// `$fill` (which outputs the row filled), `$prunedAt` (when the raw part was
// dropped to save space). An answer that isn't an object (a list) sits under
// `$answer`. The answer panel shows the answer without them; "add a field"
// reads the answer and follows `$fill`, so a new column fills exactly the rows
// the run filled.
import type { OutputFill } from './enrich-cells';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const META = new Set(['$trimmedPaths', '$fill', '$prunedAt', '$answer']);

export interface StoredAnswer {
  body: unknown;              // treg's answer (plus _cubex) without the notes
  trimmedPaths: string[];
  prunedAt: string | null;
  fill: OutputFill;
}

// What enrich-row-write stores: the kept answer with the row's fill rule.
export function withFill(stored: unknown, fill: OutputFill): unknown {
  if (isObj(stored)) return { ...stored, $fill: fill };
  return { $answer: stored, $fill: fill };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

// Rows stored before `$fill` existed: the run's rule read back from _cubex.
function legacyFill(body: unknown): OutputFill {
  const c = isObj(body) && isObj(body._cubex) ? body._cubex : null;
  if (!c) return 'all';
  if (c.outcome === 'hit' || typeof c.email === 'string') return 'all';
  if (typeof c.rejected_email === 'string') return 'cubex';
  return 'outcome' in c || 'steps' in c ? 'none' : 'all';
}

export function readStored(stored: unknown): StoredAnswer {
  if (!isObj(stored)) return { body: stored, trimmedPaths: [], prunedAt: null, fill: 'all' };
  const wrapped = '$answer' in stored && Object.keys(stored).every(k => META.has(k));
  const body = wrapped ? stored.$answer : Object.fromEntries(Object.entries(stored).filter(([k]) => !META.has(k)));
  const fill = stored.$fill === 'all' || stored.$fill === 'cubex' || stored.$fill === 'none'
    ? stored.$fill : legacyFill(body);
  return {
    body, trimmedPaths: strings(stored.$trimmedPaths),
    prunedAt: typeof stored.$prunedAt === 'string' ? stored.$prunedAt : null, fill,
  };
}

// Whether a run's output at `jsonPath` reads this answer (enrich-cells.ts rule).
export function fillReads(fill: OutputFill, jsonPath: string): boolean {
  return fill === 'all' || (fill === 'cubex' && jsonPath.startsWith('$._cubex.'));
}

export function parseStored(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
