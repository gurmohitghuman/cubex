// The few items a mistyped or wrong value most likely meant (pure): MCP error answers suggest them
// (mcp/next-steps.ts), and a {{Column}} reference someone typed is checked the same way
// (column-ref-resolve.ts suggestColumn). An item matches by any of its keys, such as its name and its id.

// Edits between two strings: a letter added, dropped or changed, or two letters next to each other
// swapped ("Emial" is one edit from "Email").
export function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (swapped) cur[j] = Math.min(cur[j], before[j - 2] + 1);
    }
    [before, prev] = [prev, cur];
  }
  return prev[b.length];
}

// Case, spaces and punctuation aside: "Company Name", "company_name" and "companyName" are one key.
const keyOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 200);

// How far a key is from what was given: 0 the same, 1 one inside the other (each at least 3 characters),
// else 2 plus the edits, when they are few for the length (1 for up to 7 characters, up to 3 for longer).
// Infinity: not close.
function farness(given: string, key: string): number {
  if (!given || !key) return Infinity;
  if (given === key) return 0;
  const [short, long] = given.length <= key.length ? [given, key] : [key, given];
  if (short.length >= 3 && long.includes(short)) return 1 + (long.length - short.length) / 1000;
  const allowed = Math.min(3, Math.max(1, Math.floor(long.length / 8)));
  if (long.length - short.length > allowed) return Infinity;
  const edits = editDistance(given, key);
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
