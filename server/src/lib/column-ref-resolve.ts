// Resolving a {{Column}} reference someone typed (pure): "Only run if" rules
// (run-condition.ts) and formulas (formula/refs.ts) read columns the same way.
import { normalizeColumnName } from './prompt';

// The sheet column a reference means: its exact name, else the one name it
// matches ignoring case, else the one whose normalized form matches.
export function resolveColumnRef(ref: string, columns: string[]): string | null {
  if (columns.includes(ref)) return ref;
  const lower = columns.filter(c => c.toLowerCase() === ref.toLowerCase());
  if (lower.length === 1) return lower[0];
  const norm = columns.filter(c => normalizeColumnName(c) === normalizeColumnName(ref));
  return norm.length === 1 ? norm[0] : null;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// The column a misspelled reference most likely meant: one containing it (or
// contained in it), else the nearest by a few typos. '' when none is close.
export function suggestColumn(ref: string, columns: string[]): string {
  const n = normalizeColumnName(ref);
  const scored = columns.map(c => {
    const cn = normalizeColumnName(c);
    return { c, d: cn.includes(n) || n.includes(cn) ? 0 : distance(n, cn) };
  }).filter(x => x.d <= Math.max(2, Math.floor(n.length / 4))).sort((a, b) => a.d - b.d);
  return scored.length ? ` Did you mean "${scored[0].c}"?` : '';
}
