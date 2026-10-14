// Capitalization helpers shared by the title case, company and person name
// cleaners (pure).

// Splits "(Acme)," into "(", "Acme", "),": the outer characters that aren't
// letters, digits or combining marks, and the word between them.
export function splitAffixes(token: string): [string, string, string] {
  const lead = /^[^\p{L}\p{N}\p{M}]*/u.exec(token)![0];
  const rest = token.slice(lead.length);
  const trail = /[^\p{L}\p{N}\p{M}]*$/u.exec(rest)![0];
  return [lead, rest.slice(0, rest.length - trail.length), trail];
}

// A character's capital, unless that is two letters (ß → SS, ﬁ → FI): those
// stay as they are, so a second pass reads the same word.
const upperChar = (ch: string): string => {
  const up = ch.toUpperCase();
  return [...up].length === 1 ? up : ch;
};
export const upper = (word: string): string => [...word].map(upperChar).join('');

// First character upper, the rest lower.
export function capitalize(word: string): string {
  const [first = '', ...rest] = [...word];
  return upperChar(first) + rest.join('').toLowerCase();
}

// After an apostrophe that follows a single letter, a capital: O'Fallon,
// D'Angelo. After a longer stretch it stays lower: It's, Macy's.
export const capAfterOneLetterApostrophe = (word: string): string =>
  word.replace(/(^|[^\p{L}\p{M}])(\p{L})(['’])(\p{L})/gu,
    (_m, before: string, letter: string, mark: string, next: string) => before + letter + mark + upperChar(next));

export const hasVowel = (word: string): boolean => /[aeiouy]/i.test(word.normalize('NFKD'));

// Some letter is lower case / upper case.
export const hasLower = (s: string): boolean => /\p{Ll}/u.test(s);
export const hasUpper = (s: string): boolean => /\p{Lu}/u.test(s);
