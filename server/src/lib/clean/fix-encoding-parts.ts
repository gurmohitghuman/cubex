// The characters a pass of fix_encoding has worked out (fix-encoding-pass.ts)
// and its mixed-word rule: no word holds both a Latin letter and a character
// of a script other than Latin, Common or Inherited, digits and signs
// included. A lead left behind by a lost byte ("Î" in "ÎÎ»...") isn't Latin,
// and a character decoded from three or four bytes in a run (next to another
// character decoded in the same pass) doesn't mix, whatever its script: a
// word garbled whole comes as such a run ("USBã‚±ãƒ¼ãƒ–ãƒ«" is "USBケーブル",
// "Nikeà¸£à¸­à¸‡..." is Thai), a real accented letter before two marks as
// one character ("«Ya está…»").

import type { Seq } from './fix-encoding-bytes';
import { scriptAt, wordCharAt, wordCharBefore } from './fix-encoding-chars';

const OTHER_SCRIPT = /[^\p{sc=Latn}\p{sc=Zyyy}\p{sc=Zinh}]/u;
const LATIN = /\p{sc=Latn}/u;
const UPPER = /^\p{Lu}$/u;

// The characters of a group (fix-encoding-pass.ts) so far, from `start`, in
// pieces: a stretch of the value taken as it came is one piece, a character
// decoded in this pass another. A cell can hold 200,000 characters, so the
// characters a check reads (those before a sequence) are read from the value
// and the decoded ones, not stored one by one.
interface Unit { at: number; len: number; text: string; out: number }
interface Stretch { from: number; to: number; out: number }
export class Parts {
  private readonly pieces: string[] = [];
  private readonly units: Unit[] = [];
  private readonly stretches: Stretch[] = [];
  private end: number;
  length = 0;
  constructor(private readonly s: string, private readonly start: number) {
    this.end = start;
  }

  // Takes the value as it came up to `to`.
  takeTo(to: number): void {
    if (to <= this.end) return;
    this.stretches.push({ from: this.end, to, out: this.length });
    this.pieces.push(this.s.slice(this.end, to));
    this.length += to - this.end;
    this.end = to;
  }

  decode(q: Seq): void {
    this.units.push({ at: q.at, len: q.len, text: q.text, out: this.length });
    this.pieces.push(q.text);
    this.length += q.text.length;
    this.end = q.at + q.len;
  }

  joined(): string { return this.pieces.join(''); }

  // Where the character `back` before the end is (1: the last one; one UTF-16
  // unit when taken as it came): a decoded unit's index, -2 - its offset in the
  // value when taken as it came, or -1 before the group.
  private find(back: number): number {
    let pos = this.end;
    let u = this.units.length - 1;
    for (let b = 1; ; b++) {
      const unit = this.units[u];
      if (unit && unit.at + unit.len === pos) {
        if (b === back) return u;
        pos = unit.at;
        u--;
      } else {
        if (pos === this.start) return -1;
        if (b === back) return -1 - pos;
        pos--;
      }
    }
  }

  text(back: number): string {
    const at = this.find(back);
    return at >= 0 ? this.units[at].text : at === -1 ? '' : this.s[-2 - at];
  }

  // A capital taken as it came, `back` characters before the end.
  takenCapital(back: number): boolean {
    const at = this.find(back);
    return at < -1 && UPPER.test(this.s[-2 - at]);
  }

  // Whether the word the pass is in holds a character decoded in this pass.
  decodedInWord(inWord: (text: string) => boolean): boolean {
    let pos = this.end;
    const unit = this.units[this.units.length - 1];
    for (;;) {
      if (unit && unit.at + unit.len === pos) return inWord(unit.text);
      if (pos === this.start || !inWord(this.s[pos - 1])) return false;
      pos--;
    }
  }

  // Per offset of the joined text: a lead left behind (1: a character from
  // U+00C2 to U+00F4 taken as it came, the only ones read from bytes C2-F4) or
  // decoded from three or four bytes in a run (2: next to another decoded character).
  marks(): Uint8Array {
    const out = new Uint8Array(this.length);
    for (const st of this.stretches) {
      for (let j = st.from; j < st.to; j++) {
        const c = this.s.charCodeAt(j);
        if (c >= 0xC2 && c <= 0xF4) out[st.out + j - st.from] = 1;
      }
    }
    this.units.forEach((unit, u) => {
      const prev = this.units[u - 1];
      const next = this.units[u + 1];
      const run = (prev && prev.at + prev.len === unit.at) || (next && unit.at + unit.len === next.at);
      if (run && unit.len >= 3) out.fill(2, unit.out, unit.out + unit.text.length);
    });
    return out;
  }
}
// alone: decoded only along with a sequence that isn't (fix-encoding-pass.ts).
export interface Kept { from: number; to: number; at: number; alone: boolean }

// Whether a word holds a Latin letter that isn't a damaged lead, and a character
// of another script that wasn't decoded from three or four bytes in a run.
function mixes(word: string, from: number, mark: Uint8Array): boolean {
  let latin = false;
  let other = false;
  for (let i = 0; i < word.length && !(latin && other);) {
    const script = scriptAt(word, i);
    if (script === 2) other ||= mark[from + i] !== 2;
    else if (script === 1) latin ||= mark[from + i] !== 1;
    i += word.codePointAt(i)! > 0xFFFF ? 2 : 1;
  }
  return latin && other;
}

// The decoded sequences in a word that mixes. Only the words holding one are
// read: from each, out to the characters that end the word on either side.
export function inMixedWords(out: string, parts: Parts, kept: Kept[]): Kept[] {
  let mark: Uint8Array | null = null;
  const bad: Kept[] = [];
  for (let k = 0; k < kept.length;) {
    let from = kept[k].from;
    if (wordCharAt(out, from) === 0) {
      k++;
      continue;
    }
    for (let n = 1; from > 0 && n > 0; from -= n) n = wordCharBefore(out, from);
    let end = kept[k].from;
    for (let n = 1; end < out.length && n > 0; end += n) n = wordCharAt(out, end);
    let j = k;
    while (j < kept.length && kept[j].from < end) j++;
    const word = out.slice(from, end);
    if (OTHER_SCRIPT.test(word) && LATIN.test(word)) {
      mark ??= parts.marks();
      const plain = mark.subarray(from, end).every(m => m === 0);
      if (plain || mixes(word, from, mark)) for (let i = k; i < j; i++) bad.push(kept[i]);
    }
    k = j;
  }
  return bad;
}
