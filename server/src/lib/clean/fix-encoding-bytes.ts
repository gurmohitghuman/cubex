// The bytes behind text that was read with the wrong character set (pure), for
// the fix_encoding cleaner (fix-encoding.ts). Each character maps back to the
// byte it was read from: U+0000-U+00FF to the same byte (Latin-1, and C1 for
// the five numbers Windows-1252 leaves undefined), Windows-1252's characters
// at 0x80-0x9F to theirs; any other character (Ł, an emoji, CJK) has no byte.
// The UTF-8 sequences found in those bytes are what a repair may decode, and
// the shapes a sequence that lost a byte leaves tell the import it is there.

const CP1252_BYTE = new Map<number, number>([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C],
  [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B],
  [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F],
]);

// The byte a character was read from, or undefined when no byte reads as it.
export const byteOf = (code: number): number | undefined => (code < 0x100 ? code : CP1252_BYTE.get(code));

// A valid UTF-8 sequence of 2 to 4 bytes starting at character `at`, and the
// character it decodes to.
export interface Seq { at: number; len: number; text: string }

// The code point of the `len`-byte sequence at i, or -1 when it isn't valid
// UTF-8 (a missing or wrong continuation byte, an overlong form, a surrogate,
// past U+10FFFF). A valid one encodes back to exactly these bytes.
function decodeAt(s: string, i: number, lead: number, len: number): number {
  if (i + len > s.length) return -1;
  let cp = lead & (len === 2 ? 0x1F : len === 3 ? 0x0F : 0x07);
  for (let k = 1; k < len; k++) {
    const b = byteOf(s.charCodeAt(i + k));
    if (b === undefined || b < 0x80 || b > 0xBF) return -1;
    cp = (cp << 6) | (b & 0x3F);
  }
  const min = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000;
  return cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? -1 : cp;
}

// Every valid sequence, left to right (as a UTF-8 decoder reads them): a byte
// that starts none, and every character without a byte, stays as it is.
export function sequencesOf(s: string): Seq[] {
  const out: Seq[] = [];
  for (let i = 0; i < s.length;) {
    const b = byteOf(s.charCodeAt(i));
    const len = b === undefined || b < 0xC2 ? 0 : b <= 0xDF ? 2 : b <= 0xEF ? 3 : b <= 0xF4 ? 4 : 0;
    const cp = len > 0 ? decodeAt(s, i, b!, len) : -1;
    if (cp >= 0) {
      out.push({ at: i, len, text: String.fromCodePoint(cp) });
      i += len;
    } else i++;
  }
  return out;
}

// A character that starts a sequence (U+00C2-U+00F4) right before one read
// from a continuation byte (0x80-0xBF): without such a pair there is nothing
// to decode, so this is the cheap first look.
const escape = (c: number): string => `\\u${c.toString(16).padStart(4, '0')}`;
const CONTINUATION = `\\u0080-\\u00BF${[...CP1252_BYTE.keys()].map(escape).join('')}`;
const LEAD_PAIR = new RegExp(`[\\u00C2-\\u00F4][${CONTINUATION}]`);
export const hasLeadPair = (s: string): boolean => LEAD_PAIR.test(s);

// Cells written while U+0080-U+009F were dropped lost those bytes: text garbled
// as Latin-1 lost every continuation byte 0x80-0x9F, text garbled as
// Windows-1252 lost 0x81, 0x8D, 0x8F, 0x90 and 0x9D. What is left is no
// sequence at all, so nothing decodes it, but these shapes show it:
// - "â" and one of the signs a lost middle byte leaves, then no continuation:
//   what is left of ™ or • ("â¢"), … ("â¦"), € ("â¬"), ‰ ("â°"), ′ ″ ("â²",
//   "â³"), ‹ › ("â¹", "âº"), a narrow no-break space ("â¯"), ❤ ("â¤"), or a
//   Windows-1252 ” ("â€"). Not an apostrophe or other punctuation: Welsh
//   writes "â’r", Turkish "hâlâ…".
// - "Ã" before a lowercase letter: a capital À to ß lost its second byte
//   ("CODE Ãxitos"). No word puts "Ã" before a lowercase letter.
// - "Ã" before a capital that no Portuguese, Vietnamese or Guarani word puts
//   after it ("ÃCOLE"; "SÃO", "MÃE", "MAÇÃS", "LÃNG", "MITÃKUÑA" stay).
// - A word that starts with "â" and a later one that ends with it, after a
//   letter that doesn't follow "â" itself: quotes that both lost two bytes
//   ("âquotedâ"). Turkish "hâlâ" ends in "â" too, after "l" that follows "â".
const DAMAGED = [
  new RegExp(`\\u00E2[\\u00A2\\u00A4\\u00A6\\u00AC\\u00AF\\u00B0\\u00B2\\u00B3\\u00B9\\u00BA\\u20AC]`
    + `(?![${CONTINUATION}])`),
  /\u00C3[a-z]/,
  /\u00C3[BCDFHJLPQTVWX]/,
  /(?<![\p{L}\p{M}])\u00E2\p{L}[\s\S]*?(?<!\u00E2)\p{L}\u00E2(?![\p{L}\p{M}])/u,
];
export const holdsDamagedSequence = (s: string): boolean => DAMAGED.some(re => re.test(s));
