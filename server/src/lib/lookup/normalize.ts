// How a lookup compares values (pure): both sides go through the same steps,
// in JavaScript, never in SQL (SQL's lower() only knows A-Z, and the triggers
// can't call app code). A cell is read as text, a run's own words (⏳ ❌ ⏭️ ➕)
// as empty; then Unicode-normalized (NFC, so "é" typed two ways is one
// letter), trimmed of spaces, tabs, line breaks and no-break spaces, and
// lowercased. Equals compares keys: the normalized value, or for a value over
// LOOKUP_KEY_MAX_CHARS its hash after a space (a trimmed value never starts
// with one, so the two can't meet). Contains looks for the normalized value of
// this row inside the other sheet's normalized text, cut to
// LOOKUP_TEXT_MAX_CHARS.
import { createHash } from 'crypto';
import { LOOKUP_CONTAINS_MIN_CHARS, LOOKUP_KEY_MAX_CHARS, LOOKUP_TEXT_MAX_CHARS } from '../constants';
import { holdsRunMarker, trimBlank } from '../run-markers';

export function lookupValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (holdsRunMarker(s)) return '';
  return trimBlank(s.normalize('NFC')).toLowerCase();
}

export function lookupKey(normalized: string): string {
  if (normalized.length <= LOOKUP_KEY_MAX_CHARS) return normalized;
  return ' ' + createHash('sha256').update(normalized).digest('hex');
}

// What the text index holds for a value: its first LOOKUP_TEXT_MAX_CHARS
// characters (never a half of a surrogate pair).
export function lookupText(normalized: string): string {
  if (normalized.length <= LOOKUP_TEXT_MAX_CHARS) return normalized;
  const cut = normalized.slice(0, LOOKUP_TEXT_MAX_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// Characters as people count them (code points, so an emoji is one).
const codePoints = (s: string): string[] => Array.from(s);

export function containsTooShort(needle: string): boolean {
  return codePoints(needle).length < LOOKUP_CONTAINS_MIN_CHARS;
}

// The distinct three-character pieces of a value, as the text index splits it.
export function trigramsOf(s: string): string[] {
  const cp = codePoints(s);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= cp.length; i++) out.add(cp[i] + cp[i + 1] + cp[i + 2]);
  return [...out];
}

// One FTS5 string token: quotes doubled inside quotes.
export const ftsString = (s: string): string => `"${s.replace(/"/g, '""')}"`;
