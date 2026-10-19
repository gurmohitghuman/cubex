// A stored answer cut to fit an agent's context (pure): each part is sized
// once, the largest go first, and a big part keeps what fits inside it, so the
// paths an agent may add as columns stay visible. One pass per level (sizes,
// then a sort): a wide answer, such as an object with thousands of keys, costs
// one serialization, not one per cut (answer-trim.ts re-sizes per cut and is
// meant for the small answers a run stores).
import { pathSegment } from './enrich-tool-io';

// A part smaller than this isn't worth keeping a piece of.
const MIN_PART = 256;
// Left-out keys of one object listed one by one, at most.
const MAX_LISTED = 10;
// Parts nested deeper than this are left out whole (each level is sized again).
const MAX_DEPTH = 32;

// The size of a part too deeply nested to serialize on this stack (JSON.stringify recurses per level, and Windows'
// 1 MB main-thread stack runs out a few thousand levels down on Node 22): over any budget, so fit() goes in and cuts
// it at MAX_DEPTH, yet small enough that totals stay exact integers.
const UNMEASURABLE = 2 ** 40;

const sizeOf = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 4;
  } catch (err) {
    if (err instanceof RangeError) return UNMEASURABLE;
    throw err;
  }
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// The value within `max` characters of JSON (budgets count characters, as an
// agent's context does) (undefined: none of it fits), and
// the paths left out in `cut` ("$.raw", or "$.items[20:]" for a list's tail).
function fit(v: unknown, max: number, size: number, path: string, cut: string[], depth = 0): unknown {
  if (size <= max) return v;
  if (max < MIN_PART || depth >= MAX_DEPTH || (!Array.isArray(v) && !isObj(v))) { cut.push(path); return undefined; }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    let used = 2;
    for (let i = 0; i < v.length; i++) {
      const s = sizeOf(v[i]);
      if (used + s + 1 <= max) { out.push(v[i]); used += s + 1; continue; }
      const part = out.length === 0 ? fit(v[i], max - used - 1, s, `${path}[${i}]`, cut, depth + 1) : undefined;
      if (part !== undefined) { out.push(part); used += sizeOf(part) + 1; i++; }
      if (i < v.length) cut.push(`${path}[${i}:]`);
      break;
    }
    return out;
  }
  const entries = Object.entries(v).map(([k, val]) => ({ k, val, key: sizeOf(k) + 1, size: sizeOf(val) }));
  let total = 2 + entries.reduce((n, e) => n + e.key + e.size + 1, 0);
  const kept = new Map(entries.map(e => [e.k, e.val]));
  const dropped: string[] = [], inside: string[] = [];
  for (const e of [...entries].sort((a, b) => b.size - a.size)) {
    if (total <= max) break;
    total -= e.size;
    const childPath = `${path}${pathSegment(e.k)}`, partCut: string[] = [];
    const part = fit(e.val, max - total, e.size, childPath, partCut, depth + 1);
    if (part === undefined) { kept.delete(e.k); total -= e.key + 1; dropped.push(childPath); continue; }
    inside.push(...partCut);
    kept.set(e.k, part);
    total += sizeOf(part);
  }
  // Many keys left out of one object read as one line, not thousands.
  const n = (x: number) => x.toLocaleString('en-US');
  cut.push(...(dropped.length > MAX_LISTED
    ? [`${path}.* (${n(dropped.length)} of ${n(entries.length)} keys left out)`] : dropped), ...inside);
  return Object.fromEntries(entries.filter(e => kept.has(e.k)).map(e => [e.k, kept.get(e.k)]));
}

export function budgetAnswer(value: unknown, max: number): { value: unknown; cut: string[] } {
  const cut: string[] = [];
  const out = fit(value, max, sizeOf(value), '$', cut);
  return out === undefined || sizeOf(out) > max ? { value: null, cut: ['$'] } : { value: out, cut };
}
