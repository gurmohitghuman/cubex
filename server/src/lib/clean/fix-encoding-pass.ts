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
//   before punctuation would give a lowercase or rare letter ("JOSÉ’S").
// - At the end of a word, right after a capital taken as it came, it isn't
//   read from a capital and a mark that follows words ("AMANHÃ…", "OCKSÅ…",
//   "PÅ’", "AMANHÃ" before a no-break space stay), unless it gives a lowercase
//   letter after one capital ("JÄ…" is "Ją") or the word already holds a
//   character decoded in this pass ("PÅ˜Ã" + U+008D + "LIÅ" + no-break space
//   is "PŘÍLIŠ"). A capital decoded in this pass is garbled, not real.
// - Three bytes right after a Latin letter give a Latin letter, a character of
//   U+2000-U+214F (’ “ ” … € ™ –), a symbol not read from two marks as below
//   ("Parisâ†’Berlin" is "Paris→Berlin"), or anything when another
//   sequence starts right after them, as in garbled Japanese, Chinese and
//   Korean ("Tã‚·ãƒ£ãƒ„" is "Tシャツ"). A lowercase accented letter before two
//   marks would give a CJK character or a number form: "“Cliché…”",
//   "«Ya está…»" and "hâlâ…”" stay.
// - Decoded only along with another sequence of the value (alone): a word of
//   its own read from a capital and a mark that follows words ("so Ä… ja"; a
//   no-break space too, unless it gives a Latin-1 letter: "vou Ã" + no-break
//   space + " praia" is "vou à praia"), the start of a word read from a capital
//   and an apostrophe ("Ç’kemi" is Albanian), three bytes making a word of
//   their own, read from a letter other than â (the lead of symbols), that give
//   neither a Latin letter nor U+2000-U+214F ("«Ela é…»"), and three bytes
//   after a Latin letter read from two marks that follow words, the second one
//   that follows a closing quote too, ending the word unless that mark is a
//   long dash or a no-break space ("está»¹" stays; "Má»¹" alone stays,
//   "Hà Nội và Mỹ Tho" and "Nguyá»…n" are repaired). Also two bytes at the end
//   of a word right after a capital taken as it came, read from a capital and a
//   footnote mark (¹ ² ³), that give a lowercase letter, unless one capital
//   before gives a Latin-1 letter ("SÃ³" is "Só") or the word holds a character
//   decoded in this pass ("AMANHÃ²" and "GÅ³" stay, "JÅ³ vaikai ir Å¡uo" is
//   "Jų vaikai ir šuo"; a capital comes out anyway: "LIETUVIÅ²" is
//   "LIETUVIŲ"), and two bytes read from × that touch no other sequence ("1920"
//   + no-break space + "×" + no-break space + "1080" stays; Hebrew words come
//   as runs). Garbled text has more sequences ("Å’uvreâ€¦"), real text has none.
// - A sequence a round leaves as it is stays so in the rounds after it.
// - No word mixes scripts (fix-encoding-parts.ts), but a character decoded from
//   three or four bytes next to another decoded one may sit in a Latin word,
//   whatever its script ("Nikeà¸£à¸­à¸‡..." is Thai). Each word that would mix
//   has its sequences left as they are, and the pass is worked out again.
// Each decoded character encodes back to exactly its bytes. Superscripts ¹ ² ³
// after a sequence don't make it part of a word.
import { stripControlChars } from '../csv-safety';
import { sequencesOf, type Seq } from './fix-encoding-bytes';
import { groupsOf, type Group } from './fix-encoding-groups';
import { inMixedWords, Parts, type Kept } from './fix-encoding-parts';

const UNASSIGNED = /\p{Cn}/u;
const UPPER = /^\p{Lu}$/u;
const LOWER = /^\p{Ll}$/u;
const LETTER = /^\p{L}$/u;
const LATIN_LETTER = /^(?=\p{L})\p{sc=Latn}$/u;
const LATIN1_LETTER = /^(?=\p{L})[\u00C0-\u00FF]$/u;
const SYMBOL = /^\p{S}$/u;
const IN_WORD = /^(?![\u00B2\u00B3\u00B9])[\p{L}\p{M}\p{N}]$/u;
// What two bytes may give right after capitals (see the top).
const AFTER_CAPITALS = new RegExp('^(?:[\\u0080-\\u00BF\\u00DF\\u00E0-\\u00F4\\u018F\\u01A0\\u01AF\\u0218\\u021A]'
  + '|(?=\\p{Lu})[\\u00C0-\\u017F])$', 'u');
// Marks that follow words: … „ · » “ ” ’ ‘ ‚ – (and the long dash) • « ‹ ›.
const AFTER_WORDS = new Set([
  ...'\u2026\u201E\u00B7\u00BB\u201C\u201D\u2019\u2018\u201A\u2013\u2014\u2022\u00AB\u2039\u203A',
]);
const NO_BREAK_SPACE = '\u00A0';
// For two continuation characters: the marks above, a no-break space, ¹ ² ³.
const FOLLOW_WORDS = new Set([...AFTER_WORDS, NO_BREAK_SPACE, '\u00B9', '\u00B2', '\u00B3']);
// The second of them: one that follows a closing quote in real text (» … ” ’ – and the long dash, a no-break
// space, ¹ ² ³). The others there are Vietnamese letters: á» and “ is ồ, ‘ is ố, • is ổ, ‹ is ị, › is ớ.
const AFTER_CLOSING = new Set(['\u00BB', '\u2026', '\u201D', '\u2019', '\u2013', '\u2014', NO_BREAK_SPACE,
  '\u00B9', '\u00B2', '\u00B3']);
// Footnote marks.
const SUPERSCRIPTS = new Set(['\u00B9', '\u00B2', '\u00B3']);
// Marks a word may follow right away: a long dash, a no-break space.
const BEFORE_WORDS = new Set(['\u2014', NO_BREAK_SPACE]);
const APOSTROPHE = '\u2019';
// The one Latin-1 lead that isn't a letter: × before a continuation character reads as a Hebrew letter.
const TIMES = '\u00D7';
const SYMBOL_LEAD = '\u00E2';
// Three bytes after a Latin letter: what ’ “ ” … € ™ – give (the number forms start at U+2150).
const PUNCTUATION_FROM = 0x2000;
const PUNCTUATION_TO = 0x214F;

const punctuationLike = (t: string) => {
  const c = t.codePointAt(0)!;
  return c >= PUNCTUATION_FROM && c <= PUNCTUATION_TO;
};
const inWord = (t: string) => IN_WORD.test(t);
const wordEndsAfter = (q: Seq, s: string) => !inWord(s[q.at + q.len] ?? '');
const followsWords = (c: string) => AFTER_WORDS.has(c) || c === NO_BREAK_SPACE;
// Three bytes whose two continuation characters follow words, the second as after a closing quote, at the end
// of a word unless a word may follow it ("está»¹", "está»" + a long dash + "dijo"; "Nguyá»…n" is "Nguyễn").
const twoMarks = (q: Seq, s: string) => q.len === 3 && FOLLOW_WORDS.has(s[q.at + 1])
  && AFTER_CLOSING.has(s[q.at + 2]) && (BEFORE_WORDS.has(s[q.at + 2]) || wordEndsAfter(q, s));

// Two bytes read from a capital and a footnote mark at the end of a word, right
// after a capital taken as it came, that give a lowercase letter: a real word's
// footnote ("AMANHÃ²", "GÅ³") reads this way, unless one capital before gives a
// Latin-1 letter ("SÃ³" is "Só") or the word already holds a character decoded
// in this pass.
function footnoteAfterCapitals(q: Seq, s: string, parts: Parts): boolean {
  if (!SUPERSCRIPTS.has(s[q.at + 1]) || !wordEndsAfter(q, s) || !parts.takenCapital(1) || !LOWER.test(q.text)) {
    return false;
  }
  return (parts.takenCapital(2) || !LATIN1_LETTER.test(q.text)) && !parts.decodedInWord(inWord);
}

// Whether sequence q may be decoded, given the characters before it, the value
// it is in, and whether another sequence starts right after it.
function mayDecode(q: Seq, s: string, parts: Parts, runFollows: boolean): boolean {
  const t = q.text;
  q.kept ??= stripControlChars(t) === t && t !== '\uFFFD' && t !== '\uFEFF' && !UNASSIGNED.test(t);
  if (!q.kept) return false;
  if (q.len === 3 && LATIN_LETTER.test(parts.text(1))) {
    return LATIN_LETTER.test(t) || punctuationLike(t) || runFollows || (SYMBOL.test(t) && !twoMarks(q, s));
  }
  if (q.len !== 2) return true;
  if (parts.takenCapital(1) && parts.takenCapital(2) && !AFTER_CAPITALS.test(t)) return false;
  if (!wordEndsAfter(q, s) || !parts.takenCapital(1) || !followsWords(s[q.at + 1])) return true;
  const titleCase = !LETTER.test(parts.text(2)) && LOWER.test(t);
  return titleCase || parts.decodedInWord(inWord);
}

function isAlone(q: Seq, s: string, parts: Parts, inRun: boolean): boolean {
  if (q.len === 2 && ((s[q.at] === TIMES && !inRun) || footnoteAfterCapitals(q, s, parts))) return true;
  const before = parts.text(1);
  if (q.len === 3 && LATIN_LETTER.test(before)) return twoMarks(q, s);
  if (inWord(before)) return false;
  const wordEnds = wordEndsAfter(q, s);
  if (q.len === 3) return wordEnds && s[q.at] !== SYMBOL_LEAD && !LATIN_LETTER.test(q.text) && !punctuationLike(q.text);
  if (q.len !== 2) return false;
  const follows = s[q.at + 1];
  const mark = AFTER_WORDS.has(follows) || (follows === NO_BREAK_SPACE && !LATIN1_LETTER.test(q.text));
  return (mark && wordEnds) || (follows === APOSTROPHE && UPPER.test(s[q.at]));
}

// The group with every sequence decoded that may be, except those refused.
function decodeGroup(s: string, g: Group, refused: Set<number>): void {
  const parts = new Parts(s, g.from);
  const kept: Kept[] = [];
  g.seqs.forEach((q, n) => {
    parts.takeTo(q.at);
    const runFollows = g.seqs[n + 1]?.at === q.at + q.len;
    if (refused.has(q.at) || !mayDecode(q, s, parts, runFollows)) return;
    const runBefore = n > 0 && g.seqs[n - 1].at + g.seqs[n - 1].len === q.at;
    const alone = isAlone(q, s, parts, runFollows || runBefore);
    kept.push({ from: parts.length, to: parts.length + q.text.length, at: q.at, alone });
    parts.decode(q);
  });
  parts.takeTo(g.to);
  Object.assign(g, { parts, kept, out: parts.joined(), alone: kept.every(k => k.alone) });
}

// Rounds of decoding left for the whole repair of one value (fix-encoding.ts).
export interface Rounds { left: number }
export const OUT_OF_ROUNDS = Symbol('out of rounds');

// One pass, null when it decodes nothing, or OUT_OF_ROUNDS when the value's
// rounds ran out first.
export function repairOnce(s: string, rounds: Rounds): string | null | typeof OUT_OF_ROUNDS {
  const seqs = sequencesOf(s);
  if (seqs.length === 0) return null;
  const groups = groupsOf(s, seqs);
  const refused = new Set<number>();
  let dirty = groups;
  for (;;) {
    if (rounds.left <= 0) return OUT_OF_ROUNDS;
    rounds.left -= 1;
    for (const g of dirty) decodeGroup(s, g, refused);
    if (groups.every(g => g.alone)) return null;
    dirty = dirty.filter(g => {
      const bad = inMixedWords(g.out, g.parts, g.kept);
      if (bad.length === 0) return false;
      for (const k of bad) refused.add(k.at);
      // What this round left as it came stays so: the decoded sequences only get
      // fewer, so leaving one as it is can't let its neighbour decode and mix in turn.
      let k = 0;
      for (const q of g.seqs) if (g.kept[k]?.at === q.at) k++; else refused.add(q.at);
      return true;
    });
    if (dirty.length === 0) return groups.map(g => g.out).join('');
    if (refused.size === seqs.length) return null;
  }
}
