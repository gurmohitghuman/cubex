// What search looks for (pure): a cell whose text contains the typed text,
// case ignored (JavaScript's toLowerCase, as filters fold text), outer spaces
// of the typed text ignored. A cell holding a run's own words (⏳, ❌, ⏭️, ➕)
// never matches: they're Cubex's words, not data.
//
// Checking every cell of a million rows in JavaScript takes seconds, so SQLite
// first drops the rows that can't match, with LIKE (ASCII case ignored, about
// 0.3 µs a row) on a piece of the text that LIKE reads exactly as
// toLowerCase does: ASCII, and characters no other character lower-cases to.
// Two exceptions are kept out of pieces: "k" (the Kelvin sign K lower-cases
// to it) and an "i" ending the text ("İ" lower-cases to "i" + a combining dot).
// The whole row's JSON is checked first, then each searched column's value:
// the JSON escapes " and \ and control characters, a column's value doesn't.
import { holdsRunMarker } from '../run-markers';

export const foldNeedle = (q: string): string => q.trim().toLowerCase();

let targets: Set<string> | null = null;
// Characters some OTHER character lower-cases to ("ü" from "Ü"): LIKE wouldn't
// match those. Read from this runtime's own toLowerCase once (about 0.1 s).
function lowerTargets(): Set<string> {
  if (targets) return targets;
  targets = new Set();
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    const lower = c.toLowerCase();
    if (lower !== c) for (const ch of lower) targets.add(ch);
  }
  // The one lower-casing that depends on context: Σ ending a word becomes ς.
  targets.add('\u03c2');
  return targets;
}

// Whether LIKE on SQLite's text reads `ch` (already lower-cased) as toLowerCase would.
function likeSafe(ch: string, inJson: boolean): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) {
    if (ch === 'k') return false;
    if (inJson && (cp < 0x20 || ch === '"' || ch === '\\')) return false;
    return true;
  }
  return !(cp >= 0xd800 && cp <= 0xdfff) && !lowerTargets().has(ch);
}

// The longest run of the needle LIKE can look for ('' = none).
export function likePiece(needle: string, inJson: boolean): string {
  const chars = [...needle];
  let best = '', run: string[] = [];
  const close = (next: string | undefined) => {
    // A run's last "i" could be the "i" of "İ" when the text ends there or a combining dot follows.
    if (run.length && run[run.length - 1] === 'i' && (next === undefined || next === '̇')) run.pop();
    if (run.join('').length > best.length) best = run.join('');
    run = [];
  };
  chars.forEach((ch, i) => {
    if (likeSafe(ch, inJson)) run.push(ch); else close(chars[i]);
  });
  close(undefined);
  return best;
}

// A LIKE pattern finding `piece` anywhere, with \ as the ESCAPE character.
export const likePattern = (piece: string): string => `%${piece.replace(/[\\%_]/g, '\\$&')}%`;

// A cell as the grid shows it.
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function cellMatches(value: unknown, needle: string): boolean {
  const text = cellText(value);
  return text !== '' && !holdsRunMarker(text) && text.toLowerCase().includes(needle);
}
