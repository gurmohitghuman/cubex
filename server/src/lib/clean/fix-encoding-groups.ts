// The groups a pass of fix_encoding (fix-encoding-pass.ts) works a value out in.
import { FIX_ENCODING_GROUP_CHARS } from '../constants-clean';
import type { Seq } from './fix-encoding-bytes';
import { wordCharAt } from './fix-encoding-chars';
import { Parts, type Kept } from './fix-encoding-parts';

// A part of the value whose sequences are worked out on their own. Each but
// the first starts at a character between two sequences (so taken as it came)
// that no word holds: a space, a sign, "、" or "。". It stops every check that
// reads back, and words don't cross it. A round works out again only the
// groups whose words mixed scripts, so a long cell costs one reading per pass,
// not one per round.
export interface Group {
  from: number; to: number; seqs: Seq[]; parts: Parts; kept: Kept[]; out: string; alone: boolean;
}

function separatorIn(s: string, from: number, to: number): number {
  for (let i = from; i < to; i++) if (wordCharAt(s, i) === 0) return i;
  return -1;
}

// Groups of at least FIX_ENCODING_GROUP_CHARS characters (but the last).
export function groupsOf(s: string, seqs: Seq[]): Group[] {
  const groups: Group[] = [];
  const add = (from: number, to: number, first: number, end: number) => groups.push({
    from, to, seqs: seqs.slice(first, end), parts: new Parts(s, from), kept: [], out: '', alone: true,
  });
  let from = 0;
  let first = 0;
  for (let n = 1; n < seqs.length; n++) {
    const after = seqs[n - 1].at + seqs[n - 1].len;
    const cut = after - from < FIX_ENCODING_GROUP_CHARS ? -1 : separatorIn(s, after, seqs[n].at);
    if (cut < 0) continue;
    add(from, cut, first, n);
    from = cut;
    first = n;
  }
  add(from, s.length, first, seqs.length);
  return groups;
}
