// What get_sheet (and REST GET /sheets/:id) says about each column, the pure
// part: the shape, the size rules and the masking. services/column-details.ts
// reads the records. A column's kind says what fills it; each kind that fills
// several columns at once says which part a column is (role), and the main
// column carries the run or setup (fill) while the others name it (filled_by).
import { findKeys, type KeyFinding } from './curl/key-detect';

export type ColumnKind =
  | 'plain' | 'ai' | 'http' | 'enrichment' | 'waterfall' | 'webhook' | 'clean' | 'formula' | 'lookup';

export type ColumnRole =
  | 'answer'    // an AI column's one answer column ("Score (Output)"), or a waterfall's result column
  | 'answered_by'  // a waterfall's "answered by" column: the step that answered each row
  | 'step'      // the column of one waterfall step: that step's own value
  | 'status'    // the per-row state column of an AI run with output columns, or of an enrichment
  | 'output'    // a value column of one of those runs
  | 'sources'   // an AI run's "(Data)" column: the web sources it used
  | 'response'  // an HTTP API column's response column
  | 'field'     // a value an HTTP API column or a webhook picks out of its JSON
  | 'payload';  // a webhook's own column

export interface ColumnCounts { filled: number; empty: number; errors: number }

export interface ColumnDetail {
  name: string;
  kind: ColumnKind;
  role?: ColumnRole;
  filled_by?: string;              // the column holding what fills this one, when it isn't this one
  fill?: Record<string, unknown>;  // what fills it: its newest run, or its setup
  reads?: string[];                // the columns it reads
  auto_run?: boolean;
  auto_run_paused?: string;        // why auto-run is paused, while it is
  auto_run_caps?: { usd_per_day?: number; rows_per_day?: number };
  run_if?: string | null;          // its "Only run if" rule
  description?: string;
  counts?: ColumnCounts | null;    // null: not counted (still filling, or past the cap)
}

// Text cut to max characters (whole code points), marked with "…".
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max).join('')}…`;
}

// A request URL as column details show it to any token that can read: every
// key typed into it reads "…". Keys are found the way a pasted cURL command's
// are (lib/curl/key-detect.ts: key-named parameters, key formats, keys in the
// path such as a webhook's), and user info before the host goes whole. A
// {{name}} names a column or a saved key, never the value, so it stays. When
// the URL can't be read for keys, everything after the host goes.
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i;
const ORIGIN = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i;
const ONLY_REFS = /^(\{\{[^{}]+\}\})*$/;

// text with each [start, end) span replaced by "…".
function maskSpans(text: string, spans: Array<[number, number]>): string {
  let out = text;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)}…${out.slice(b)}`;
  return out;
}

export function maskUrlSecrets(url: string): string {
  const hashAt = url.indexOf('#');
  const noHash = (hashAt < 0 ? url : url.slice(0, hashAt)).replace(USERINFO,
    (whole, scheme: string, info: string) => (info.split(':').every(p => ONLY_REFS.test(p)) ? whole : `${scheme}…@`));
  const q = noHash.indexOf('?');
  const base = q < 0 ? noHash : noHash.slice(0, q);
  const query = q < 0 ? [] : noHash.slice(q + 1).split('&').map(part => {
    const eq = part.indexOf('=');
    return eq < 0 ? { key: part, value: '', bare: true }
      : { key: part.slice(0, eq), value: part.slice(eq + 1), bare: false };
  });
  let keys: KeyFinding[];
  try {
    keys = findKeys({ method: 'GET', base, query, headers: [] }, { resolves: () => true, variables: [] })
      .filter(k => k.kind === 'value');
  } catch {
    return `${ORIGIN.exec(base)?.[1] ?? ''}/…`;
  }
  const at = (k: KeyFinding): [number, number] => [k.start, k.end];
  const maskedBase = maskSpans(base, keys.filter(k => k.field.at === 'url').map(at));
  const parts = query.map((part, index) => {
    const mine = keys.filter(k => k.field.at === 'query' && k.field.index === index);
    const key = maskSpans(part.key, mine.filter(k => k.inKey).map(at));
    const value = maskSpans(part.value, mine.filter(k => !k.inKey).map(at));
    return part.bare ? key : `${key}=${value}`;
  });
  return q < 0 ? maskedBase : `${maskedBase}?${parts.join('&')}`;
}

// An entry by name, kind and where it sits only (what a cut list keeps).
export const shortDetail = (d: ColumnDetail): ColumnDetail => ({
  name: d.name, kind: d.kind, ...(d.role ? { role: d.role } : {}), ...(d.filled_by ? { filled_by: d.filled_by } : {}),
  ...(d.counts !== undefined ? { counts: d.counts } : {}),
});

// Whole entries in order until about maxChars, the rest short. keep: entries
// kept whole wherever they fall (the columns a call names).
export function fitDetails(
  details: ColumnDetail[], maxChars: number, keep: ReadonlySet<string> = new Set(),
): { details: ColumnDetail[]; shortened: number } {
  let used = 0;
  let shortened = 0;
  const out = details.map(d => {
    const size = JSON.stringify(d).length;
    if (keep.has(d.name) || used + size <= maxChars) { used += size; return d; }
    shortened++;
    const short = shortDetail(d);
    used += JSON.stringify(short).length;
    return short;
  });
  return { details: out, shortened };
}
