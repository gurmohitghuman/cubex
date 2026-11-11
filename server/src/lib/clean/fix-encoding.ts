// The fix_encoding cleaner (pure): repairs UTF-8 text that was decoded as
// Windows-1252 or Latin-1, once or twice over ("CafÃ©" gives "Café",
// "Ã¢â‚¬â„¢" gives "’"). Unlike every other cleaner it doesn't tidy spaces
// first: what it can't repair comes back exactly as it came, so it never
// blanks a value or drops a character. A pass (fix-encoding-pass.ts) decodes
// each sequence it can read and may decode, and leaves a damaged spot (such as
// a sequence that lost a byte) as it came; C1 characters may be left by one
// pass: text garbled twice as Latin-1 holds them after one.
//
// Passes repeat until one decodes nothing, at most FIX_ENCODING_MAX_PASSES; if
// one more would still decode, the value is left as it came. All the passes
// share FIX_ENCODING_MAX_ROUNDS rounds; a value whose rounds run out is left as
// it came too. The answer is the last value of that chain without C1
// characters, or the value as it came when none after it qualifies. Cleaning a
// cleaned value changes nothing: a pass (and the rounds it takes) depends only
// on its input, so the chain from an answer is the rest of the first chain,
// which ends within both caps and holds a C1 character in every value after
// the answer. The cell policy check keeps C1, so it leaves the chain as it is.
import { FIX_ENCODING_MAX_PASSES, FIX_ENCODING_MAX_ROUNDS, MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { stripControlChars } from '../csv-safety';
import { hasLeadPair, holdsDamagedSequence, sequencesOf } from './fix-encoding-bytes';
import { OUT_OF_ROUNDS, repairOnce } from './fix-encoding-pass';

const NON_ASCII = /[^\u0000-\u007F]/;
const C1 = /[\u0080-\u009F]/;

export function fixEncoding(value: string): string {
  if (typeof value !== 'string') return '';
  const rounds = { left: FIX_ENCODING_MAX_ROUNDS };
  let answer = value;
  let s = value;
  for (let pass = 0; pass < FIX_ENCODING_MAX_PASSES; pass++) {
    const next = repairOnce(s, rounds);
    if (next === OUT_OF_ROUNDS) return value;
    if (next === null) return answer;
    s = next;
    if (!C1.test(s)) answer = s;
  }
  return repairOnce(s, rounds) === null ? answer : value;
}

// Whether a value looks like text read with the wrong character set: it holds
// a C1 character, a sequence that lost a byte (fix-encoding-bytes.ts), a
// sequence that decodes to a character the cell policy strips (which
// fix_encoding leaves), or fix_encoding would change it. Plain ASCII is
// answered at once, and a value longer than MAX_CLEAN_FIELD_CHARS by the C1
// test only.
export function looksGarbled(value: string): boolean {
  if (!NON_ASCII.test(value)) return false;
  if (C1.test(value)) return true;
  if (value.length > MAX_CLEAN_FIELD_CHARS) return false;
  if (holdsDamagedSequence(value)) return true;
  if (!hasLeadPair(value)) return false;
  return sequencesOf(value).some(q => stripControlChars(q.text) !== q.text) || fixEncoding(value) !== value;
}
