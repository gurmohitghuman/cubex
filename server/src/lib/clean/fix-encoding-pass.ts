// One pass of the fix_encoding cleaner (fix-encoding.ts), pure. It maps the
// characters back to the bytes they were read from (fix-encoding-bytes.ts) and
// decodes each valid UTF-8 sequence it finds, one by one: a damaged spot (a
// lost byte, a character no byte reads as, such as an emoji) stays as it is,
// and the sequences around it are still repaired. A sequence is decoded only
// when what it gives is a character the cell policy keeps (stripControlChars
// removes nothing from it: no direction control), isn't U+FFFD, U+FEFF or
// unassigned, and fits where it lands:
// - Right after two or more capitals (letters taken as they came, not decoded
//   in this pass) it gives a capital, ß, a Latin-1 sign, à to ô (which start a
//   longer form garbled twice) or a C1 character (gone after a later pass).
//   Text in capitals garbled gives those ("CAFÃ‰" is "CAFÉ"); real capitals
//   before punctuation would give a lowercase or rare letter ("JOSÉ’S" and
//   "PÂTÉ’S" would hold "ɒ").
// - At the end of a word, right after a capital, it isn't read from a capital
//   and the punctuation that follows words ("AMANHÃ…", "OCKSÅ…", "PÅ’" stay),
//   unless it gives a lowercase letter after one capital: "JÄ…" is "Ją".
// - A word of its own read from a capital and such punctuation ("so Ä… ja"),
//   or the start of a word read from a capital and an apostrophe ("Ç’kemi" is
//   Albanian), is decoded only along with another sequence of the value:
//   garbled text ("Å’uvreâ€¦", "Ð¼Ð°Ð¼Ð° Ñ– Ñ‚Ð°Ñ‚Ð¾") has more, real text has none.
// - No word holds both a Latin letter and a character of a script UTF-8's
//   two-byte forms decode to, digits and signs included ("Gruß“" and
//   "Viel Spaß…" stay: "ß“" and "ß…" give NKo characters). A lead left behind
//   by a lost byte (the "Î" of "ÎÎ»..." when "Ε" lost one) doesn't count as
//   Latin. Each word that would has its sequences left as they are, and the
//   pass is worked out again.
// Each decoded character encodes back to exactly its bytes.
import { FIX_ENCODING_MAX_ROUNDS } from '../constants-clean';
import { stripControlChars } from '../csv-safety';
import { byteOf, sequencesOf, type Seq } from './fix-encoding-bytes';

const UNASSIGNED = /\p{Cn}/u;
const UPPER = /^\p{Lu}$/u;
const LOWER = /^\p{Ll}$/u;
const LETTER = /^\p{L}$/u;
const IN_WORD = /^[\p{L}\p{M}\p{N}]$/u;
// What two bytes may give right after capitals (see the top).
const AFTER_CAPITALS = new RegExp('^(?:[\\u0080-\\u00BF\\u00DF\\u00E0-\\u00F4\\u018F\\u01A0\\u01AF\\u0218\\u021A]'
  + '|(?=\\p{Lu})[\\u00C0-\\u017F])$', 'u');
// Punctuation that follows words: … „ · » “ ” ’ ‘ ‚ – (and the long dash) • « ‹ ›.
const AFTER_WORDS = new Set([
  ...'\u2026\u201E\u00B7\u00BB\u201C\u201D\u2019\u2018\u201A\u2013\u2014\u2022\u00AB\u2039\u203A',
]);
const APOSTROPHE = '\u2019';
const TWO_BYTE_SCRIPTS = '\\p{sc=Grek}\\p{sc=Copt}\\p{sc=Cyrl}\\p{sc=Armn}\\p{sc=Hebr}\\p{sc=Arab}\\p{sc=Syrc}'
  + '\\p{sc=Thaa}\\p{sc=Nkoo}';
const WORD = new RegExp(`[\\p{L}\\p{M}\\p{N}${TWO_BYTE_SCRIPTS}]+`, 'gu');
const TWO_BYTE_SCRIPT = new RegExp(`^[${TWO_BYTE_SCRIPTS}]$`, 'u');
const LATIN = /^\p{sc=Latn}$/u;

// A character of the pass so far: decoded in this pass, or taken as it came
// (damaged: one that starts a sequence, left behind).
interface Part { text: string; decoded: boolean; damaged: boolean }
// alone: decoded only along with a sequence that isn't (see the top).
interface Kept { from: number; to: number; at: number; alone: boolean }

function capitalsBefore(parts: Part[]): number {
  let n = 0;
  for (let k = parts.length - 1; k >= 0 && !parts[k].decoded && UPPER.test(parts[k].text); k--) n++;
  return n;
}

// Whether sequence q may be decoded, given the characters before it and the value it is in.
function mayDecode(q: Seq, s: string, parts: Part[]): boolean {
  const t = q.text;
  if (stripControlChars(t) !== t || t === '\uFFFD' || t === '\uFEFF' || UNASSIGNED.test(t)) return false;
  if (q.len !== 2) return true;
  if (capitalsBefore(parts) >= 2 && !AFTER_CAPITALS.test(t)) return false;
  const last = parts[parts.length - 1]?.text ?? '';
  const before = parts[parts.length - 2]?.text ?? '';
  const wordEnds = !IN_WORD.test(s[q.at + q.len] ?? '');
  const titleCase = !LETTER.test(before) && LOWER.test(t);
  return !(wordEnds && UPPER.test(last) && AFTER_WORDS.has(s[q.at + 1]) && !titleCase);
}

function isAlone(q: Seq, s: string, parts: Part[]): boolean {
  if (q.len !== 2 || IN_WORD.test(parts[parts.length - 1]?.text ?? '')) return false;
  const follows = s[q.at + 1];
  return (AFTER_WORDS.has(follows) && !IN_WORD.test(s[q.at + q.len] ?? ''))
    || (follows === APOSTROPHE && UPPER.test(s[q.at]));
}

// The value with every sequence decoded that may be, except those refused.
function decodeAll(s: string, seqs: Seq[], refused: Set<number>): { parts: Part[]; kept: Kept[] } {
  const parts: Part[] = [];
  const kept: Kept[] = [];
  let length = 0;
  let next = 0;
  for (let i = 0; i < s.length;) {
    const q = seqs[next]?.at === i ? seqs[next++] : null;
    if (q && !refused.has(q.at) && mayDecode(q, s, parts)) {
      kept.push({ from: length, to: length + q.text.length, at: q.at, alone: isAlone(q, s, parts) });
      parts.push({ text: q.text, decoded: true, damaged: false });
      length += q.text.length;
      i += q.len;
    } else {
      const b = byteOf(s.charCodeAt(i));
      parts.push({ text: s[i], decoded: false, damaged: b !== undefined && b >= 0xC2 && b <= 0xF4 });
      length += 1;
      i += 1;
    }
  }
  return { parts, kept };
}

// The decoded sequences that sit in a word mixing Latin with a two-byte script.
function inMixedWords(parts: Part[], kept: Kept[]): Kept[] {
  const out = parts.map(p => p.text).join('');
  const damagedAt = new Set<number>();
  let at = 0;
  for (const p of parts) {
    if (p.damaged) damagedAt.add(at);
    at += p.text.length;
  }
  const bad: Kept[] = [];
  for (const m of out.matchAll(WORD)) {
    let latin = false;
    let twoByte = false;
    for (let k = 0; k < m[0].length;) {
      const ch = String.fromCodePoint(m[0].codePointAt(k)!);
      if (TWO_BYTE_SCRIPT.test(ch)) twoByte = true;
      else if (LATIN.test(ch) && !damagedAt.has(m.index! + k)) latin = true;
      k += ch.length;
    }
    if (!latin || !twoByte) continue;
    const end = m.index! + m[0].length;
    bad.push(...kept.filter(k => k.from < end && k.to > m.index!));
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
    const bad = inMixedWords(parts, kept);
    if (bad.length === 0) return parts.map(p => p.text).join('');
    for (const k of bad) refused.add(k.at);
  }
  return null;
}
