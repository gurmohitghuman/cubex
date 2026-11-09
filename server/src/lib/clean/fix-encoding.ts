// The fix_encoding cleaner (pure): repairs UTF-8 text that was decoded as
// Windows-1252 or Latin-1, once or twice over ("CafÃ©" gives "Café",
// "Ã¢â‚¬â„¢" gives "’"). Unlike every other cleaner it doesn't tidy spaces
// first: a value it can't repair comes back exactly as it came, so it never
// blanks a value or drops a character.
//
// A pass maps each character back to the byte it was read from and decodes the
// bytes as strict UTF-8. It counts only when that decodes, the text gets
// shorter, no U+FFFD is left, the result encodes back to exactly those bytes,
// no word mixes a Latin letter with a letter of a script UTF-8's two-byte forms
// decode to ("Gruß“" stays, though its "ß“" decodes to an NKo letter), and
// right after two or more capitals A to Z two bytes decode to a capital, ß, a
// Latin-1 sign or a letter that starts a longer UTF-8 form: text in capitals
// garbled gives those ("CAFÃ‰" is "CAFÉ"), while real capitals before
// punctuation would give a lowercase or rare letter ("JOSÉ’S" would be
// "JOSɒS"). One capital is title case: "MÃ¼ller" is "Müller".
//
// Passes repeat until one doesn't count, at most FIX_ENCODING_MAX_PASSES; if
// one more would still count, the value is left as it came. A pass may leave
// C1 characters (text garbled twice as Latin-1 does: "Ã¢Â\u0084Â¢" is
// "â\u0084¢" after one): the answer is the last value of the chain with none,
// or the value as it came when no later one qualifies. Cleaning a cleaned value
// changes nothing: passes don't depend on anything but their input, so the
// chain from an answer is the rest of the first chain, which ends within the
// cap and holds a C1 character in every value after the answer.
import { FIX_ENCODING_MAX_PASSES } from '../constants-clean';

// Windows-1252's characters at 0x80-0x9F. The five numbers it leaves undefined,
// and every one in Latin-1, read as the C1 character of the same number, which
// maps to its byte with the rest of U+0000-U+00FF.
const CP1252_BYTE = new Map<number, number>([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C],
  [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B],
  [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F],
]);

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const REPLACEMENT = /\uFFFD/;
const NON_ASCII = /[^\u0000-\u007F]/;
const C1 = /[\u0080-\u009F]/;
const WORD = /[\p{L}\p{M}]+/gu;
const LATIN = /\p{Script=Latin}/u;
// What two bytes may give right after capitals A to Z: a Latin-1 sign, ß, a
// capital of Latin-1 or Latin Extended-A, Ə Ơ Ư Ș Ț (Azerbaijani, Vietnamese,
// Romanian), or à to ô, which start a longer form (a "’" garbled twice after
// capitals: "MCDONALDÃ¢â‚¬â„¢S" is "MCDONALDâ€™S" after one pass).
const AFTER_CAPITALS = new RegExp('^(?:[\\u00A0-\\u00BF\\u00DF\\u00E0-\\u00F4\\u018F\\u01A0\\u01AF\\u0218\\u021A]'
  + '|(?=\\p{Lu})[\\u00C0-\\u017F])$', 'u');
const TWO_BYTE_SCRIPT = new RegExp('[\\p{Script=Greek}\\p{Script=Coptic}\\p{Script=Cyrillic}\\p{Script=Armenian}'
  + '\\p{Script=Hebrew}\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}]', 'u');

// The bytes the value was read from, or null when there is nothing to repair:
// a character no single byte reads as, or no UTF-8 lead byte followed by a
// continuation byte (without one, nothing decodes shorter).
function bytesOf(s: string): Uint8Array | null {
  const bytes = new Uint8Array(s.length);
  let pair = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const b = code < 0x100 ? code : CP1252_BYTE.get(code);
    if (b === undefined) return null;
    bytes[i] = b;
    if (!pair && b >= 0x80 && b <= 0xBF && i > 0 && bytes[i - 1] >= 0xC2 && bytes[i - 1] <= 0xF4) pair = true;
  }
  return pair ? bytes : null;
}

function mixesScripts(s: string): boolean {
  for (const [word] of s.matchAll(WORD)) if (LATIN.test(word) && TWO_BYTE_SCRIPT.test(word)) return true;
  return false;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const CAPITAL = /^[A-Z]$/;

// Whether every two-byte sequence right after two or more capitals A to Z gave
// a character that may follow them. `out` decoded from `bytes` (one character
// per sequence). Only A to Z: in text garbled more than once, a capital before
// a sequence (Ã, Â) can be garbage itself.
function capitalsStay(bytes: Uint8Array, out: string): boolean {
  const chars = Array.from(out);
  for (let i = 0, k = 0; i < bytes.length; k++) {
    const b = bytes[i];
    const len = b < 0x80 ? 1 : b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2;
    const afterCapitals = k > 1 && CAPITAL.test(chars[k - 1]) && CAPITAL.test(chars[k - 2]);
    if (len === 2 && afterCapitals && !AFTER_CAPITALS.test(chars[k])) return false;
    i += len;
  }
  return true;
}

// One pass, or null when it doesn't count.
function repairOnce(s: string): string | null {
  const bytes = bytesOf(s);
  if (!bytes) return null;
  let out: string;
  try { out = decoder.decode(bytes); } catch { return null; }
  if (out.length >= s.length || REPLACEMENT.test(out) || mixesScripts(out)) return null;
  return sameBytes(encoder.encode(out), bytes) && capitalsStay(bytes, out) ? out : null;
}

export function fixEncoding(value: string): string {
  if (typeof value !== 'string') return '';
  let answer = value;
  let s = value;
  for (let pass = 0; pass < FIX_ENCODING_MAX_PASSES; pass++) {
    const next = repairOnce(s);
    if (next === null) return answer;
    s = next;
    if (!C1.test(s)) answer = s;
  }
  return repairOnce(s) === null ? answer : value;
}

// Whether a value looks like text read with the wrong character set: it holds
// a C1 character, or fix_encoding would change it. Plain ASCII is answered
// without looking further.
export function looksGarbled(value: string): boolean {
  if (!NON_ASCII.test(value)) return false;
  return C1.test(value) || fixEncoding(value) !== value;
}
