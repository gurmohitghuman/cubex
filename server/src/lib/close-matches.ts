// The few items a mistyped or wrong value most likely meant (pure): MCP error answers suggest them
// (mcp/next-steps.ts), and a {{Column}} reference someone typed is checked the same way
// (column-ref-resolve.ts suggestColumn). An item matches by any of its keys, such as its name and its id.

// Edits between two strings: a letter added, dropped or changed, or two letters next to each other
// swapped ("Emial" is one edit from "Email"). With max, it answers max + 1 for anything over max, and
// works out only the cells within max of the diagonal, stopping at a row whose every cell is over max:
// the work is at most the length times (2 max + 1), whatever the caller sent.
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const band = Math.min(max, Math.max(a.length, b.length));
  const far = a.length + b.length + 1;
  // Three rows, reused: the one before last (for a swap), the last, and this one. A cell outside the band
  // is never read before it is written, except the band's two edges, set to far on each row.
  let before = new Array<number>(b.length + 1).fill(far);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => (j <= band ? j : far));
  let cur = new Array<number>(b.length + 1).fill(far);
  for (let i = 1; i <= a.length; i++) {
    const lo = Math.max(1, i - band), hi = Math.min(b.length, i + band);
    cur[lo - 1] = lo === 1 ? i : far;
    if (hi < b.length) cur[hi + 1] = far;
    let least = cur[lo - 1];
    for (let j = lo; j <= hi; j++) {
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      cur[j] = d;
      if (d < least) least = d;
    }
    if (least > max) return max + 1;
    [before, prev, cur] = [prev, cur, before];
  }
  return prev[b.length] > max ? max + 1 : prev[b.length];
}

// Case, spaces and punctuation aside: "Company Name", "company_name" and "companyName" are one key.
const keyOf = (s: string) => s.slice(0, 1000).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 200);

// How far a key is from what was given: 0 the same; 1 a key holding what was given (at least 3 characters:
// "lea" in "Leads", a cut id); 2 plus the edits, when they are few for the length (1 for up to 7 characters,
// up to 3 for longer); 6 a key inside what was given, after every typo: for "Emial Address", "Email Address"
// (a typo of the whole) comes before "Address" (a part of it). Infinity: not close.
function farness(given: string, key: string): number {
  if (!given || !key) return Infinity;
  if (given === key) return 0;
  const [short, long] = given.length <= key.length ? [given, key] : [key, given];
  if (short.length >= 3 && long.includes(short)) return (short === given ? 1 : 6) + (long.length - short.length) / 1000;
  const allowed = Math.min(3, Math.max(1, Math.floor(long.length / 8)));
  if (long.length - short.length > allowed) return Infinity;
  const edits = editDistance(given, key, allowed);
  return edits <= allowed ? 2 + edits : Infinity;
}

// The items whose keys come closest to given, closest first, at most limit of them. When a key is the same
// (case, spaces and punctuation aside), only those: "company name" means "Company Name", not "Name".
export function closeMatches<T>(given: string, items: readonly T[], keys: (item: T) => string[], limit = 3): T[] {
  const g = keyOf(given);
  const near = items
    .map((item, at) => ({ item, at, far: Math.min(...keys(item).map(k => farness(g, keyOf(k)))) }))
    .filter(x => x.far !== Infinity)
    .sort((a, b) => a.far - b.far || a.at - b.at);
  return near.filter(x => x.far === 0 || near[0].far !== 0).slice(0, limit).map(x => x.item);
}
