// Person name cleaners (pure): the full name in natural order without
// honorific, nickname or suffix ("smith, john q." → "John Q. Smith"), or just
// its first or last name. Each reads the value through nameText (emoji
// dropped, full-width letters folded) and leaves a placeholder ("n/a",
// "unknown") blank. The first- and last-name cleaners can also read a column
// that holds only first names, or only last names (NameInput).
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { isJoiningParticle, recaseName, type NameRole } from './name-case';
import { CAPITAL_PARTICLES, HONORIFICS, PARTICLES, SUFFIXES, nameKey } from './name-words';
import { isPlaceholder, nameText } from './name-text';
import { cleanTrim } from './text';
import { hasLower, hasUpper } from './word-case';

type Mode = 'full' | 'first' | 'last';
// What the source holds: whole names (read for the part asked for), or only
// first names (first-name cleaner) or only last names (last-name cleaner).
export type NameInput = 'full_name' | 'first_name' | 'last_name';

const isSuffix = (w: string) => SUFFIXES.has(nameKey(w));
const isParticle = (w: string) => PARTICLES.has(nameKey(w));
// One cased letter, with or without its period: "J", "J.". "J.R." and "AJ" are
// names, and so is one Han or Hangul character (伟, 민): those scripts have no case.
const isInitial = (w: string) => /^[\p{Lu}\p{Ll}\p{Lt}]\.?$/u.test(w);
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

// part: the value holds one part of a name only (NameInput), every word of it.
interface Parsed { words: string[]; roles: NameRole[]; part: boolean }

// s: the value as nameText gives it.
function parseName(s: string, mode: Mode): Parsed | null {
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
  return { words, roles, part: false };
}

// A value that holds one part only: honorifics and nicknames go, suffixes
// after a last name, and initials before a first name, titles and initials in
// any order ("J. Dr. Michael"), so one pass leaves nothing for another; every
// word left is that part, particles included ("VAN DER BERG" → "van der Berg").
function parsePart(s: string, part: 'first' | 'last'): Parsed | null {
  const words = wordsOf(cleanTrim(dropNicknames(s).replace(/,/g, ' ')));
  if (part === 'last') while (words.length > 1 && isSuffix(words[words.length - 1])) words.pop();
  for (let n = -1; n !== words.length;) {
    n = words.length;
    while (words.length > 1 && HONORIFICS.has(nameKey(words[0]))) words.shift();
    if (part === 'first') while (words.length && isInitial(words[0])) words.shift();
  }
  if (!words.length) return null;
  const roles = words.map((_, i): NameRole => (part === 'last' ? 'last' : i === 0 ? 'first' : 'middle'));
  return { words, roles, part: true };
}

// Where the first name is: the first word before the last name that isn't an
// initial ("J. Michael Fox" → Michael). The last name is never the first name,
// so a first name of initials only is none ("J. Smith", "Mr. R. Patel", "J.").
function firstNameAt(p: Parsed): number {
  const lastAt = p.roles.indexOf('last');
  const end = lastAt < 0 ? p.words.length : lastAt;
  for (let i = 0; i < end; i++) if (!isInitial(p.words[i])) return i;
  return -1;
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
// its output reads as a last name again. The first name is recased as one.
function pick(p: Parsed | null, mode: Mode): string {
  if (!p) return '';
  const at = mode === 'first' && !p.part ? firstNameAt(p) : -1;
  if (mode === 'first' && !p.part && at < 0) return '';
  const roles = p.roles.map((r, i): NameRole => (i === at ? 'first' : r));
  const words = recaseName(p.words, roles, typedAllCaps(p.words)).map((w, i) =>
    (mode === 'last' && isJoiningParticle(w, roles[i], i, roles.length) ? w.toLowerCase() : w));
  if (at >= 0) return words[at];
  return words.filter((_, i) => mode === 'full' || p.part || roles[i] === mode).join(' ');
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

// One pass: an email address or a link isn't a name, nor is a placeholder,
// read before and after (cleaning "Mr. Test" gives "Test", which reads as one).
function cleanOnce(value: string, mode: Mode, part: boolean): string {
  const s = nameText(value);
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS || /@|:\/\//.test(s) || isPlaceholder(s, true)) return '';
  const out = pick(part && mode !== 'full' ? parsePart(s, mode) : parseName(s, mode), mode);
  return isPlaceholder(out, true) ? '' : out;
}

const clean = (mode: Mode, part: boolean, value: string): string => settle(v => cleanOnce(v, mode, part), value);

export const cleanPersonName = (value: string): string => clean('full', false, value);
// A lone word is a first name ("Cher"), except after an honorific.
export const cleanFirstName = (value: string, input: 'full_name' | 'first_name' = 'full_name'): string =>
  clean('first', input === 'first_name', value);
export const cleanLastName = (value: string, input: 'full_name' | 'last_name' = 'full_name'): string =>
  clean('last', input === 'last_name', value);
