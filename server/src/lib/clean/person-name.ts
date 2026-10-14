// Person name cleaners (pure): the full name in natural order without
// honorific, nickname or suffix ("smith, john q." → "John Q. Smith"), or just
// its first or last name.
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { isJoiningParticle, recaseName, type NameRole } from './name-case';
import { CAPITAL_PARTICLES, HONORIFICS, PARTICLES, SUFFIXES, nameKey } from './name-words';
import { cleanTrim } from './text';
import { hasLower, hasUpper } from './word-case';

type Mode = 'full' | 'first' | 'last';

const isSuffix = (w: string) => SUFFIXES.has(nameKey(w));
const isParticle = (w: string) => PARTICLES.has(nameKey(w));
// After a comma a credential can be any short all-capital word (in a name
// that isn't all in capitals) or a dotted one (M.D.).
const isCommaSuffix = (w: string, mixedCase: boolean) =>
  isSuffix(w) || (mixedCase && /^\p{Lu}{2,6}$/u.test(w)) || /^\p{L}+\.(?:\p{L}+\.?)+$/u.test(w);

// Nicknames and asides go: "Robert (Bob) Jones", 'William "Bill" Gates', and
// "William 'Bill' O'Reilly" when both single quotes sit at word edges, a comma
// counting as one (so the apostrophe in O'Reilly stays). A name wrapped whole
// in quotes is unwrapped first.
function dropNicknames(s: string): string {
  return s.replace(/^["“'‘](.*)["”'’]$/u, '$1')
    .replace(/\([^()]*\)|"[^"]*"|“[^“”]*”/g, ' ')
    .replace(/(^|[\s,])['‘][^'‘’\s][^'‘’]*['’](?=[\s,]|$)/g, '$1 ')
    .replace(/[()"“”]/g, ' ');
}

const wordsOf = (s: string) => s.split(' ').filter(Boolean);

// The words in natural order. With a comma: "John Smith, Jr." and "Jane Doe,
// MBA, PMP" are a name and its suffixes (only suffixes after the comma, more
// than one word before it); otherwise "Smith, John Q." is last name first
// ("Smith Jr., John"; "Smith, John, Jr." puts suffixes after a second comma).
function naturalOrder(s: string): string[] {
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return wordsOf(parts[0] ?? '');
  const before = wordsOf(parts[0]);
  const after = parts.slice(1).flatMap(wordsOf);
  const mixedCase = hasLower(s) && hasUpper(s);
  if (after.every(w => isCommaSuffix(w, mixedCase)) && (before.length > 1 || after.every(isSuffix))) return before;
  return [...wordsOf(parts[1]), ...before];
}

interface Parsed { words: string[]; roles: NameRole[] }

function parseName(value: string, mode: Mode): Parsed | null {
  const s = cleanTrim(value);
  // An email address or a link isn't a name.
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS || /@|:\/\//.test(s)) return null;
  const words = naturalOrder(cleanTrim(dropNicknames(s)));
  while (words.length > 1 && isSuffix(words[words.length - 1])) words.pop();
  let honorific = false;
  while (words.length > 1 && HONORIFICS.has(nameKey(words[0]))) {
    words.shift();
    honorific = true;
  }
  if (!words.length) return null;
  // A last name only: what's left after an honorific ("Mr. Johnson", "Dr. de
  // la Vega"), a lone word handed to the last-name cleaner (so that its own
  // output, "Johnson", cleans to itself), and a name that starts like one.
  const lastOnly = (honorific && words.slice(0, -1).every(isParticle))
    || (mode === 'last' && words.length === 1) || startsAsLastName(words);
  // Otherwise the last word is the last name (a lone word is a first name),
  // with the particles right before it; one in first place is a first name
  // (Van Morrison, Di Wang).
  let lastStart = words.length > 1 ? words.length - 1 : 1;
  while (lastStart > 1 && isParticle(words[lastStart - 1])) lastStart--;
  if (lastOnly) lastStart = 0;
  const roles = words.map((_, i): NameRole => (i >= lastStart ? 'last' : i === 0 ? 'first' : 'middle'));
  return { words, roles };
}

// Starting with St./Ste. ("St. Clair"), or with a particle written in lower
// case in a name that has capitals ("van Beethoven", "de la Vega"): no first
// name there. A capitalized one is a first name: Van Morrison, Di Wang.
function startsAsLastName(words: string[]): boolean {
  if (words.length < 2) return false;
  const key = nameKey(words[0]);
  return CAPITAL_PARTICLES.has(key) || (PARTICLES.has(key) && !hasUpper(words[0]) && words.some(hasUpper));
}

// "Entirely in capitals" needs two words or more: a lone "AJ" can't tell.
const typedAllCaps = (words: string[]) => {
  const lettered = words.filter(w => /\p{L}/u.test(w));
  return lettered.length > 1 && !lettered.some(hasLower) && lettered.some(hasUpper);
};

// The words the mode asks for, recased word by word. The last-name cleaner
// writes its particles in lower case ("Vincent Van Gogh" → "van Gogh"), so
// its output reads as a last name again.
function pick(p: Parsed | null, mode: Mode): string {
  if (!p) return '';
  const { roles } = p;
  const words = recaseName(p.words, roles, typedAllCaps(p.words)).map((w, i) =>
    (mode === 'last' && isJoiningParticle(w, roles[i], i, roles.length) ? w.toLowerCase() : w));
  return words.filter((_, i) => mode === 'full' || roles[i] === mode).join(' ');
}

// A first or last name read on its own can read differently than inside the
// whole name (a particle before a word with no capitals: "le 1st" after a
// first name, "Le 1st" alone), so the result is cleaned again until it holds
// still, and cleaning it once more changes nothing. Real names hold at once.
function settle(clean: (value: string) => string, value: string): string {
  let out = clean(value);
  for (let i = 0; i < 3; i++) {
    const again = clean(out);
    if (again === out) break;
    out = again;
  }
  return out;
}

const cleaner = (mode: Mode) => (value: string): string => settle(v => pick(parseName(v, mode), mode), value);

export const cleanPersonName = cleaner('full');
// A lone word is a first name ("Cher"), except after an honorific.
export const cleanFirstName = cleaner('first');
export const cleanLastName = cleaner('last');
