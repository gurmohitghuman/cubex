// Resolving a {{Column}} reference someone typed (pure): "Only run if" rules
// (run-condition.ts) and formulas (formula/refs.ts) read columns the same way.
import { normalizeColumnName } from './prompt';
import { editDistance } from './close-matches';

// The sheet column a reference means: its exact name, else the one name it
// matches ignoring case, else the one whose normalized form matches.
export function resolveColumnRef(ref: string, columns: string[]): string | null {
  if (columns.includes(ref)) return ref;
  const lower = columns.filter(c => c.toLowerCase() === ref.toLowerCase());
  if (lower.length === 1) return lower[0];
  const norm = columns.filter(c => normalizeColumnName(c) === normalizeColumnName(ref));
  return norm.length === 1 ? norm[0] : null;
}

// The column a misspelled reference most likely meant: one containing it (or
// contained in it), else the nearest by a few typos. '' when none is close.
export function suggestColumn(ref: string, columns: string[]): string {
  const n = normalizeColumnName(ref);
  const most = Math.max(2, Math.floor(n.length / 4));
  const scored = columns.map(c => {
    const cn = normalizeColumnName(c);
    return { c, d: cn.includes(n) || n.includes(cn) ? 0 : editDistance(n, cn, most) };
  }).filter(x => x.d <= most).sort((a, b) => a.d - b.d);
  return scored.length ? ` Did you mean "${scored[0].c}"?` : '';
}
