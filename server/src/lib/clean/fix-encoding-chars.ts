// What a character is, for fix_encoding (fix-encoding-parts.ts and
// fix-encoding-groups.ts): whether it is part of a word, and its script. A cell
// can hold 200,000 characters, so each answer for a character outside the
// surrogates is worked out once and kept by its code.

// A character of a word: a letter, mark, digit, any character of a script but Common and Inherited.
const WORD_CHAR = /^(?:[\p{L}\p{M}\p{N}]|[^\p{sc=Zyyy}\p{sc=Zinh}])$/u;
const OTHER_SCRIPT_CHAR = /^[^\p{sc=Latn}\p{sc=Zyyy}\p{sc=Zinh}]$/u;
const LATIN = /\p{sc=Latn}/u;

// The script of a character: 1 Latin, 2 another script than Latin, Common or
// Inherited, 3 neither. Characters outside the surrogates are looked up once.
const SCRIPT_BY_CODE = new Uint8Array(0x10000);
const scriptOf = (ch: string): number => (OTHER_SCRIPT_CHAR.test(ch) ? 2 : LATIN.test(ch) ? 1 : 3);
export function scriptAt(word: string, i: number): number {
  const c = word.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDFFF) return scriptOf(String.fromCodePoint(word.codePointAt(i)!));
  SCRIPT_BY_CODE[c] ||= scriptOf(word[i]);
  return SCRIPT_BY_CODE[c];
}

// Whether a character outside the surrogates is part of a word: ASCII by its
// code (its letters and digits are, the rest aren't), any other kept by its
// code once worked out (1 it is, 2 it isn't).
const asciiInWord = (c: number) => (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7A);
const IN_WORD_BY_CODE = new Uint8Array(0x10000);
function inWordCode(c: number): boolean {
  if (c < 0x80) return asciiInWord(c);
  IN_WORD_BY_CODE[c] ||= WORD_CHAR.test(String.fromCharCode(c)) ? 1 : 2;
  return IN_WORD_BY_CODE[c] === 1;
}
const isSurrogate = (c: number) => c >= 0xD800 && c <= 0xDFFF;

// The length of the word character starting at i (2 for a surrogate pair), or
// 0 when the character there isn't one.
export function wordCharAt(t: string, i: number): number {
  const c = t.charCodeAt(i);
  if (!isSurrogate(c)) return inWordCode(c) ? 1 : 0;
  const ch = String.fromCodePoint(t.codePointAt(i)!);
  return WORD_CHAR.test(ch) ? ch.length : 0;
}

// The same for the word character ending at i.
export function wordCharBefore(t: string, i: number): number {
  const c = t.charCodeAt(i - 1);
  if (!isSurrogate(c)) return inWordCode(c) ? 1 : 0;
  const high = i >= 2 ? t.charCodeAt(i - 2) : 0;
  const pair = c >= 0xDC00 && c <= 0xDFFF && high >= 0xD800 && high <= 0xDBFF;
  const ch = pair ? t.slice(i - 2, i) : t[i - 1];
  return WORD_CHAR.test(ch) ? ch.length : 0;
}
