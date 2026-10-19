// Reads the paths the click-to-map builder makes (client json-mapping/jsonPath.ts)
// literally: `$`, then `.name`, `["key"]` and `[n]` steps, each an own property
// of the value before it. jsonpath-plus parses a bracketed key's text as path
// syntax again (`@`, `,`, `*`, `'`, `^`, `$`, `..`) and never undoes its escapes,
// so it read keys common in API replies (`@odata.nextLink`, a top-level `@type`,
// "user's name") as nothing or as an error. extractOutcome (jsonpath-extract.ts) reads
// these paths literally first and falls back to jsonpath-plus when that finds nothing;
// paths with `*` or `..` go straight to jsonpath-plus. Each step reads like jsonpath-plus did for
// ordinary keys: an own property of a truthy value (`.length` of a list or a
// non-empty string, a string's `[0]`), the digits of `[n]` as written (`[01]`
// matches nothing). The client reads them the same way (json-mapping/readPath.ts).
const BS = String.fromCharCode(92);
const STEP = /\.([A-Za-z_$][A-Za-z0-9_$]*)|\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]/y;
const SHORT_BACK: Record<string, number> = { b: 8, t: 9, n: 10, f: 12, r: 13 };
const hasOwn = Object.prototype.hasOwnProperty;

// A bracketed key's text back to the key, as the client escapes it (JSON's
// string escapes): backslash u and four hex digits is that UTF-16 unit,
// backslash n/t/r/b/f the control, backslash and any other character that
// character. Raw characters stay (paths saved before keys were escaped hold them).
export function unescapeKey(text: string): string {
  if (!text.includes(BS)) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 92 || i + 1 >= text.length) { out += text[i]; continue; }
    const next = text[i + 1];
    const hex = next === 'u' ? text.slice(i + 2, i + 6) : '';
    if (/^[0-9A-Fa-f]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; continue; }
    out += next in SHORT_BACK ? String.fromCharCode(SHORT_BACK[next]) : next;
    i++;
  }
  return out;
}

// The keys a path steps through, or null for a path outside that grammar. Parsed
// once per path: a run or a webhook reads the same few paths for every row.
const cache = new Map<string, readonly string[] | null>();
const CACHE_MAX = 1000;

export function literalSteps(path: string): readonly string[] | null {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let steps: string[] | null = path.startsWith('$') ? [] : null;
  STEP.lastIndex = 1;
  while (steps && STEP.lastIndex < path.length) {
    const at = STEP.lastIndex;
    const m = STEP.exec(path);
    if (!m || m.index !== at) steps = null;
    else steps.push(m[1] ?? (m[2] !== undefined ? unescapeKey(m[2]) : m[3]));
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  const frozen = steps && Object.freeze(steps);
  cache.set(path, frozen);
  return frozen;
}

// The value at those steps: matched only when every step is an own property of a
// truthy value. As with jsonpath-plus, a falsy reply (0, false, '', null) matches
// nothing, `$` included, and nothing is read out of an empty string.
export function readLiteral(payload: unknown, steps: readonly string[]): { matched: boolean; value: unknown } {
  if (!payload) return { matched: false, value: null };
  let cur: unknown = payload;
  for (const key of steps) {
    if (!cur || !hasOwn.call(cur, key)) return { matched: false, value: null };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { matched: true, value: cur };
}

// Whether two paths read the same value: the same steps (a mapping saved with a
// raw character in a key, or written by the server's own path builder, equals the
// client's escaped form), else the same text.
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const x = literalSteps(a);
  const y = literalSteps(b);
  return !!x && !!y && x.length === y.length && x.every((k, i) => k === y[i]);
}
