// Auto-dedupe's key and decision (pure). A row's key is its key column's
// value read the way Remove duplicates reads it (lib/dedupe/key.ts): text
// ignores upper/lower case and extra spaces, email/domain/phone/company/person
// name go through the clean data cleaners. A blank cell, a run's status (⏳,
// ❌, ⏭️, ➕), a value its cleaner can't read and a cell over
// AUTO_DEDUPE_MAX_KEY_CHARS characters have no key: they never match.
import { keyPart, rowKey, type DedupeMatch } from '../dedupe/key';
import { trimBlank } from '../run-markers';
import { AUTO_DEDUPE_MAX_KEY_CHARS } from '../constants-dedupe';

export const AUTO_DEDUPE_KEEPS = ['oldest', 'newest'] as const;
export type AutoDedupeKeep = typeof AUTO_DEDUPE_KEEPS[number];
export const isAutoDedupeKeep = (x: unknown): x is AutoDedupeKeep =>
  typeof x === 'string' && (AUTO_DEDUPE_KEEPS as readonly string[]).includes(x);

export interface KeySpec { match: DedupeMatch; phone_country: string | null }

// Characters, not UTF-16 units: an emoji counts once.
function longer(s: string, max: number): boolean {
  if (s.length <= max) return false;
  if (s.length > max * 2) return true;
  let n = 0;
  for (const _ of s) if (++n > max) return true;
  return false;
}

// The key of a cell as SQLite's json_extract gives it (text, a number, or
// null), or null when it has none.
export function autoDedupeKey(spec: KeySpec, cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  const v = typeof cell === 'string' ? cell : String(cell);
  if (longer(trimBlank(v), AUTO_DEDUPE_MAX_KEY_CHARS)) return null;
  const part = keyPart({ column: '', match: spec.match, country: spec.phone_country ?? undefined }, v);
  return rowKey([part]);
}

// Which rows go when row `rid` is checked and other rows share its key
// (`oldest` and `newest`: the lowest and highest rowid among them all, `rid`
// included). Rows are as old as their rowid: the oldest (or newest) stays.
// 'others' when that is the row checked, 'self' when it isn't, 'none' when no
// other row shares the key.
export function whoGoes(
  keep: AutoDedupeKeep, rid: number, oldest: number, newest: number,
): 'others' | 'self' | 'none' {
  if (oldest === newest) return 'none';
  return (keep === 'oldest' ? oldest : newest) === rid ? 'others' : 'self';
}
