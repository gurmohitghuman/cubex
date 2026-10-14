// Capitalization of person names, word by word (pure). A word typed all in
// capitals or all in lower case is recased ("John SMITH" → "John Smith"); a
// word in mixed case was typed that way on purpose and is kept (DeShawn,
// LaToya, Vincent, MacKenzie).
import { CAPITAL_PARTICLES, MAC_EXCEPTIONS, MAC_FORCED, PARTICLES, nameKey } from './name-words';
import { capitalize, hasLower, hasUpper, hasVowel, upper } from './word-case';

export type NameRole = 'first' | 'middle' | 'last';

const capitals = (s: string) => [...s.replace(/[^\p{Lu}]/gu, '')].length;

// All in lower case, or all in capitals with two letters or more ("Q." is an
// initial either way). A Mc, Mac, O' or D' before the capitals counts as
// capitals too: "Ronald McDONALD" is a last name typed in capitals.
export function needsRecase(word: string): boolean {
  if (!hasLower(word)) return capitals(word) >= 2;
  if (!hasUpper(word)) return true;
  const rest = /^(?:ma?c|[od]['’])(.+)$/iu.exec(word)?.[1];
  return rest !== undefined && !hasLower(rest) && capitals(rest) >= 2;
}

// Each piece between periods and apostrophes gets a capital (J.R.R., O'Brien,
// D'Angelo), except after an apostrophe that follows more than one letter
// (the 's of a possessive stays lower).
function capitalizePieces(word: string): string {
  const pieces = word.split(/([.'’])/);
  return pieces.map((p, i) => {
    if (i % 2) return p;
    const afterLongApostrophe = i > 0 && pieces[i - 1] !== '.' && [...pieces[i - 2]].length !== 1;
    return afterLongApostrophe ? p.toLowerCase() : capitalize(p);
  }).join('');
}

// MacDonald, but Macey, Machado, Mackey: only with three letters or more after
// "Mac", not ending in a, c, i, o, z or j, and not a known exception.
function macName(lower: string): string | null {
  const forced = MAC_FORCED.get(lower);
  if (forced) return forced;
  if (!/^mac\p{L}{3,}$/u.test(lower) || /[acijoz]$/.test(lower)) return null;
  if (MAC_EXCEPTIONS.some(e => lower.startsWith(e))) return null;
  return 'Mac' + capitalize(lower.slice(3));
}

// One part of a word split on "-" and "/" (Smith-Jones gets two capitals).
function recasePart(part: string, last: boolean): string {
  const lower = part.toLowerCase();
  if (/^mc\p{L}/u.test(lower)) return 'Mc' + capitalizePieces(part.slice(2));
  const mac = last ? macName(lower) : null;
  return mac ?? capitalizePieces(part);
}

// A particle that joins the word after it: lower case, except St. and Ste.
export const isJoiningParticle = (word: string, role: NameRole, i: number, count: number): boolean =>
  PARTICLES.has(nameKey(word)) && !CAPITAL_PARTICLES.has(nameKey(word)) && role !== 'first' && i < count - 1;

// words: the name's words in order; roles: what each one is; allCaps: the
// whole name was typed in capitals (two words or more).
export function recaseName(words: string[], roles: NameRole[], allCaps: boolean): string[] {
  return words.map((word, i) => {
    if (!needsRecase(word)) return word;
    if (CAPITAL_PARTICLES.has(nameKey(word))) return capitalize(word);
    // "van" in Ludwig van Beethoven; in first place (Van Morrison) or last
    // (John Le) it's a name.
    if (isJoiningParticle(word, roles[i], i, words.length)) return word.toLowerCase();
    if (roles[i] !== 'last') {
      // Initials as one word: JJ, TJ, JRR. Never a last name (Ng).
      if (/^\p{L}{2,3}$/u.test(word) && !hasVowel(word)) return upper(word);
      // Two capitals in a name not all in capitals are initials too (AJ
      // Styles); in "AL GORE" they are a name.
      if (!allCaps && /^\p{Lu}{2}$/u.test(word)) return word;
    }
    // A "Mac" typed as such before capitals stays: MacKENZIE → MacKenzie, not
    // the Mackenzie the exceptions would give.
    const mac = /^Mac(?=\p{Lu})/u.test(word) ? 'Mac' : '';
    const parts = word.slice(mac.length).split(/([-/])/);
    return mac + parts.map((p, j) => (j % 2 ? p : recasePart(p, roles[i] === 'last'))).join('');
  });
}
