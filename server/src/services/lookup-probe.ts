// Matching one value against a looked-up column, inside the transaction that
// writes the answer, once its keys are current (services/lookup-maintain.ts):
// - equals: the key index (source_id, key, row_index), so the first matches
//   come in sheet order straight from it;
// - contains: candidates from the text index (services/lookup-text.ts), each
//   checked against the text lookup_keys keeps, then put in sheet order.
// The answer is the matching rows' rids in sheet order (as many as asked for),
// how many match, and whether there were more than LOOKUP_MAX_MATCHES (then
// a first match or a list isn't picked: the caller says so).
import { db } from '../lib/db';
import {
  LOOKUP_CANDIDATES_PER_READ, LOOKUP_MATCH_MS, LOOKUP_MAX_MATCHES, LOOKUP_RARE_TRIGRAM_ROWS, LOOKUP_SAMPLE_TRIGRAMS,
} from '../lib/constants';
import { containsTooShort, lookupKey, trigramsOf } from '../lib/lookup/normalize';
import { phraseQuery, textCandidates, trigramRows, trigramsQuery } from './lookup-text';

export interface LookupMatches {
  rids: number[];     // the first `want` matches, top of the sheet first
  count: number;      // how many match (up to LOOKUP_MAX_MATCHES + 1 for contains)
  over: boolean;      // more than LOOKUP_MAX_MATCHES match (contains, or a first match / list)
  tooShort?: boolean; // contains: the value is under LOOKUP_CONTAINS_MIN_CHARS
  tooSlow?: boolean;  // contains: matching it ran past LOOKUP_MATCH_MS
}

// What an answer needs: 'any' (yes/no), 'count', or the first `want` rows.
export type LookupNeed = { kind: 'any' } | { kind: 'count' } | { kind: 'first'; want: number };

export function matchEquals(sourceId: number, value: string, need: LookupNeed): LookupMatches {
  const key = lookupKey(value);
  if (need.kind === 'any') {
    const hit = db.prepare('SELECT rid FROM lookup_keys WHERE source_id = ? AND key = ? LIMIT 1').pluck()
      .get(sourceId, key) as number | undefined;
    return { rids: hit === undefined ? [] : [hit], count: hit === undefined ? 0 : 1, over: false };
  }
  if (need.kind === 'count') {
    const n = db.prepare('SELECT count(*) FROM lookup_keys WHERE source_id = ? AND key = ?').pluck()
      .get(sourceId, key) as number;
    return { rids: [], count: n, over: false };
  }
  // The first matches in sheet order, straight from the index.
  const rids = db.prepare(`SELECT rid FROM lookup_keys WHERE source_id = ? AND key = ?
    ORDER BY row_index LIMIT ?`).pluck().all(sourceId, key, need.want) as number[];
  return { rids, count: rids.length, over: false };
}

// A few trigrams spread over the value (a long value has hundreds).
function sampled(grams: string[]): string[] {
  if (grams.length <= LOOKUP_SAMPLE_TRIGRAMS) return grams;
  return Array.from({ length: LOOKUP_SAMPLE_TRIGRAMS },
    (_, k) => grams[Math.floor(k * (grams.length - 1) / (LOOKUP_SAMPLE_TRIGRAMS - 1))]);
}

export function matchContains(sourceId: number, needle: string, need: LookupNeed): LookupMatches {
  if (containsTooShort(needle)) return { rids: [], count: 0, over: false, tooShort: true };
  // Candidates: rows holding the needle's two rarest (sampled) trigrams, or,
  // when even the rarest is common and the needle short, the needle as a
  // phrase. Read until there are none left, a page at a time; every candidate
  // is checked against its text, so the counts only steer the speed.
  const all = trigramsOf(needle);
  const grams = sampled(all).map(g => ({ g, n: trigramRows(sourceId, g, LOOKUP_RARE_TRIGRAM_ROWS) }))
    .sort((a, b) => a.n - b.n);
  if (grams[0].n === 0) return { rids: [], count: 0, over: false };
  const phrase = grams[0].n > LOOKUP_RARE_TRIGRAM_ROWS && all.length <= LOOKUP_SAMPLE_TRIGRAMS * 2;
  const query = phrase ? phraseQuery(needle) : trigramsQuery(grams.slice(0, 2).map(x => x.g));
  const textOf = db.prepare(`SELECT row_index AS i, COALESCE(text, key) AS t FROM lookup_keys
    WHERE source_id = ? AND rid = ?`);
  const until = Date.now() + LOOKUP_MATCH_MS;
  const found: Array<{ rid: number; i: number }> = [];
  for (let after = 0; ;) {
    const page = textCandidates(sourceId, query, after, LOOKUP_CANDIDATES_PER_READ);
    for (const rid of page) {
      const k = textOf.get(sourceId, rid) as { i: number; t: string } | undefined;
      if (!k || !k.t.includes(needle)) continue;
      if (need.kind === 'any') return { rids: [rid], count: 1, over: false };
      found.push({ rid, i: k.i });
      if (found.length > LOOKUP_MAX_MATCHES) return { rids: [], count: found.length, over: true };
    }
    if (page.length < LOOKUP_CANDIDATES_PER_READ) break;
    if (Date.now() >= until) return { rids: [], count: 0, over: false, tooSlow: true };
    after = page[page.length - 1];
  }
  if (need.kind !== 'first') return { rids: [], count: found.length, over: false };
  found.sort((a, b) => a.i - b.i);
  return { rids: found.slice(0, need.want).map(f => f.rid), count: found.length, over: false };
}
