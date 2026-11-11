// One pass of the fix_encoding cleaner (fix-encoding.ts), pure: the bytes the
// characters were read from (fix-encoding-bytes.ts), each valid UTF-8 sequence
// decoded one by one, a damaged spot (a lost byte, a character no byte reads
// as) left as it is. A sequence is decoded only when it gives a character the
// cell policy keeps (stripControlChars: no direction control), not U+FFFD,
// U+FEFF or unassigned, that fits where it lands:
// - Right after two or more capitals (letters taken as they came, not decoded
//   in this pass) it gives a capital, ß, a Latin-1 sign, à to ô (which start a
//   longer form garbled twice) or a C1 character (gone after a later pass).
//   Text in capitals garbled gives those ("CAFÃ‰" is "CAFÉ"); real capitals
//   before punctuation would give a lowercase or rare letter ("JOSÉ’S" and
//   "PÂTÉ’S" would hold "ɒ").
// - At the end of a word, right after a capital, it isn't read from a capital
//   and the punctuation that follows words or a no-break space ("AMANHÃ…",
//   "OCKSÅ…", "PÅ’", "AMANHÃ" + no-break space stay), unless it gives a
//   lowercase letter after one capital: "JÄ…" is "Ją".
// - Three bytes right after a Latin letter give a Latin letter or a character
//   of U+2000-U+214F (’ “ ” … € ™ – and the like): a lowercase accented letter
//   before two punctuation marks would give a CJK or rare character
//   ("“Cliché…”", "«Ya está…»" and "hâlâ…”" stay).
// - A word of its own read from a capital and such punctuation ("so Ä… ja"),
//   the start of a word read from a capital and an apostrophe ("Ç’kemi" is
//   Albanian), or three bytes that make a word of their own, read from a letter
//   other than â (the lead of symbols: "âœ“" is ✓), and give neither a Latin
//   letter nor U+2000-U+214F ("«Ela é…»"), is decoded only along with
//   another sequence of the value: garbled text ("Å’uvreâ€¦",
//   "Ð¼Ð°Ð¼Ð° Ñ– Ñ‚Ð°Ñ‚Ð¾") has more, real text has none.
// - No word holds both a Latin letter and a character of a script other than
//   Latin, Common or Inherited, signs and digits included ("Gruß“" and
//   "Viel Spaß…" stay: "ß“" and "ß…" give NKo characters). A lead left behind
//   by a lost byte ("Î" in "ÎÎ»...") isn't Latin. Each word that would has
//   its sequences left as they are, and the pass is worked out again.
// Each decoded character encodes back to exactly its bytes.
import { FIX_ENCODING_MAX_ROUNDS } from '../constants-clean';
import { stripControlChars } from '../csv-safety';
import { byteOf, sequencesOf, type Seq } from './fix-encoding-bytes';

const UNASSIGNED = /\p{Cn}/u;
const UPPER = /^\p{Lu}$/u;
const LOWER = /^\p{Ll}$/u;
const LETTER = /^\p{L}$/u;
const LATIN_LETTER = /^(?=\p{L})\p{sc=Latn}$/u;
const IN_WORD = /^[\p{L}\p{M}\p{N}]$/u;
// What two bytes may give right after capitals (see the top).
const AFTER_CAPITALS = new RegExp('^(?:[\\u0080-\\u00BF\\u00DF\\u00E0-\\u00F4\\u018F\\u01A0\\u01AF\\u0218\\u021A]'
  + '|(?=\\p{Lu})[\\u00C0-\\u017F])$', 'u');
// Punctuation that follows words: … „ · » “ ” ’ ‘ ‚ – (and the long dash) • « ‹ ›.
const AFTER_WORDS = new Set([
  ...'\u2026\u201E\u00B7\u00BB\u201C\u201D\u2019\u2018\u201A\u2013\u2014\u2022\u00AB\u2039\u203A',
]);
const NO_BREAK_SPACE = '\u00A0';
const APOSTROPHE = '\u2019';
const SYMBOL_LEAD = '\u00E2';
// Three bytes after a Latin letter: what ’ “ ” … € ™ – give (the number forms start at U+2150).
const PUNCTUATION_FROM = 0x2000;
const PUNCTUATION_TO = 0x214F;
// A word: letters, marks, digits, any character of a script but Common and Inherited.
const WORD = /(?:[\p{L}\p{M}\p{N}]|[^\p{sc=Zyyy}\p{sc=Zinh}])+/gu;
const OTHER_SCRIPT = /[^\p{sc=Latn}\p{sc=Zyyy}\p{sc=Zinh}]/u;
const LATIN = /\p{sc=Latn}/u;

// The characters of the pass so far: text, decoded in this pass, or a lead
// left behind (damaged). Flat arrays: a cell can hold 200,000 characters.
class Parts {
  readonly texts: string[] = [];
  readonly decoded: Uint8Array;
  readonly damaged: Uint8Array;
  constructor(size: number) {
    this.decoded = new Uint8Array(size);
    this.damaged = new Uint8Array(size);
  }

  // The text `back` characters before the end (1: the last one).
  text(back: number): string { return this.texts[this.texts.length - back] ?? ''; }

  // A capital taken as it came, `back` characters before the end.
  takenCapital(back: number): boolean {
    const k = this.texts.length - back;
    return k >= 0 && !this.decoded[k] && UPPER.test(this.texts[k]);
  }

  push(text: string, decoded: boolean, damaged: boolean): void {
    const k = this.texts.length;
    this.texts.push(text);
    this.decoded[k] = decoded ? 1 : 0;
    this.damaged[k] = damaged ? 1 : 0;
  }
}
// alone: decoded only along with a sequence that isn't (see the top).
interface Kept { from: number; to: number; at: number; alone: boolean }

const punctuationLike = (t: string) => {
  const c = t.codePointAt(0)!;
  return c >= PUNCTUATION_FROM && c <= PUNCTUATION_TO;
};

// Whether sequence q may be decoded, given the characters before it and the value it is in.
function mayDecode(q: Seq, s: string, parts: Parts): boolean {
  const t = q.text;
  if (stripControlChars(t) !== t || t === '\uFFFD' || t === '\uFEFF' || UNASSIGNED.test(t)) return false;
  const last = parts.text(1);
  if (q.len === 3 && LATIN_LETTER.test(last)) return LATIN_LETTER.test(t) || punctuationLike(t);
  if (q.len !== 2) return true;
  if (parts.takenCapital(1) && parts.takenCapital(2) && !AFTER_CAPITALS.test(t)) return false;
  const wordEnds = !IN_WORD.test(s[q.at + q.len] ?? '');
  const follows = s[q.at + 1];
  const titleCase = !LETTER.test(parts.text(2)) && LOWER.test(t);
  return !(wordEnds && UPPER.test(last) && (AFTER_WORDS.has(follows) || follows === NO_BREAK_SPACE) && !titleCase);
}

function isAlone(q: Seq, s: string, parts: Parts): boolean {
  if (IN_WORD.test(parts.text(1))) return false;
  const wordEnds = !IN_WORD.test(s[q.at + q.len] ?? '');
  if (q.len === 3) return wordEnds && s[q.at] !== SYMBOL_LEAD && !LATIN_LETTER.test(q.text) && !punctuationLike(q.text);
  if (q.len !== 2) return false;
  const follows = s[q.at + 1];
  return (AFTER_WORDS.has(follows) && wordEnds) || (follows === APOSTROPHE && UPPER.test(s[q.at]));
}

// The value with every sequence decoded that may be, except those refused.
function decodeAll(s: string, seqs: Seq[], refused: Set<number>): { parts: Parts; kept: Kept[] } {
  const parts = new Parts(s.length);
  const kept: Kept[] = [];
  let length = 0;
  let next = 0;
  for (let i = 0; i < s.length;) {
    const q = seqs[next]?.at === i ? seqs[next++] : null;
    if (q && !refused.has(q.at) && mayDecode(q, s, parts)) {
      kept.push({ from: length, to: length + q.text.length, at: q.at, alone: isAlone(q, s, parts) });
      parts.push(q.text, true, false);
      length += q.text.length;
      i += q.len;
    } else {
      const b = byteOf(s.charCodeAt(i));
      parts.push(s[i], false, b !== undefined && b >= 0xC2 && b <= 0xF4);
      length += 1;
      i += 1;
    }
  }
  return { parts, kept };
}

// How many damaged leads come before each offset of the joined text.
function damagedBefore(parts: Parts, size: number): Int32Array {
  const before = new Int32Array(size + 1);
  let at = 0;
  parts.texts.forEach((text, k) => {
    for (let c = 0; c < text.length; c++, at++) before[at + 1] = before[at] + (c === 0 ? parts.damaged[k] : 0);
  });
  return before;
}

// Whether a word holds a Latin letter that isn't a damaged lead.
function holdsLatin(word: string, from: number, before: Int32Array): boolean {
  if (before[from + word.length] === before[from]) return LATIN.test(word);
  for (let i = 0; i < word.length;) {
    const ch = String.fromCodePoint(word.codePointAt(i)!);
    if (LATIN.test(ch) && before[from + i + 1] === before[from + i]) return true;
    i += ch.length;
  }
  return false;
}

// The decoded sequences in a word mixing Latin with another script (words and
// kept sequences both come in order: one pass over each).
function inMixedWords(out: string, parts: Parts, kept: Kept[]): Kept[] {
  let before: Int32Array | null = null;
  const bad: Kept[] = [];
  let k = 0;
  for (const m of out.matchAll(WORD)) {
    const from = m.index!;
    const end = from + m[0].length;
    while (k < kept.length && kept[k].to <= from) k++;
    if (k === kept.length) break;
    if (kept[k].from >= end || !OTHER_SCRIPT.test(m[0])) continue;
    before ??= damagedBefore(parts, out.length);
    if (!holdsLatin(m[0], from, before)) continue;
    for (let j = k; j < kept.length && kept[j].from < end; j++) bad.push(kept[j]);
  }
  return bad;
}

// One pass, or null when it decodes nothing.
export function repairOnce(s: string): string | null {
  const seqs = sequencesOf(s);
  if (seqs.length === 0) return null;
  const refused = new Set<number>();
  for (let round = 0; round < FIX_ENCODING_MAX_ROUNDS; round++) {
    const { parts, kept } = decodeAll(s, seqs, refused);
    if (kept.every(k => k.alone)) return null;
    const out = parts.texts.join('');
    const bad = inMixedWords(out, parts, kept);
    if (bad.length === 0) return out;
    for (const k of bad) refused.add(k.at);
    if (refused.size === seqs.length) return null;
  }
  return null;
}
