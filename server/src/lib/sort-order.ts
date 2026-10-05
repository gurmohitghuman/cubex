import { STRICT_NUMERIC, naturalCollator } from './sql-helpers';
import { yieldToRequests } from './slices';

// The physical sort's order, by the rules of compareSortValues (sql-helpers):
// blank or whitespace-only cells last in either direction, numbers before text
// (after it when descending), numbers numerically, text in natural order
// ("item2" before "item10"), and ties keep their current order. Each value is
// classified once and the sort is a merge sort over a typed array that yields
// between slices, so a million rows sort in about 100 MB without ever blocking
// the server for long.
const RUN = 16_384;           // elements sorted outright per slice
const MERGE_STEP = 100_000;   // comparisons per merge slice

// `values` in current row order; returns their indexes in sorted order.
export async function sortedOrder(values: string[], direction: 'asc' | 'desc'): Promise<Uint32Array> {
  const n = values.length;
  const kind = new Uint8Array(n); // 0 number, 1 text, 2 blank
  const num = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = values[i].trim();
    if (t === '') kind[i] = 2;
    else if (STRICT_NUMERIC.test(t)) { kind[i] = 0; num[i] = parseFloat(values[i]); }
    else kind[i] = 1;
    if (i % RUN === RUN - 1) await yieldToRequests();
  }
  const dir = direction === 'desc' ? -1 : 1;
  const compare = (a: number, b: number): number => {
    const ka = kind[a], kb = kind[b];
    let c: number;
    if (ka === 2 || kb === 2) c = ka === kb ? 0 : ka === 2 ? 1 : -1;
    else if (ka !== kb) c = dir * (ka - kb);
    else if (ka === 0) c = dir * (num[a] === num[b] ? 0 : num[a] < num[b] ? -1 : 1);
    else c = dir * naturalCollator.compare(values[a], values[b]);
    return c !== 0 ? c : a - b;
  };

  let src = new Uint32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  for (let lo = 0; lo < n; lo += RUN) {
    src.subarray(lo, Math.min(n, lo + RUN)).sort(compare);
    await yieldToRequests();
  }
  let dst = new Uint32Array(n);
  let steps = 0;
  for (let width = RUN; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n), hi = Math.min(lo + 2 * width, n);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) {
        dst[k++] = compare(src[i], src[j]) <= 0 ? src[i++] : src[j++];
        if (++steps === MERGE_STEP) { steps = 0; await yieldToRequests(); }
      }
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    [src, dst] = [dst, src];
  }
  return src;
}
