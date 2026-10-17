// The text index behind contains lookups (lookup_text, migration 031): an
// FTS5 trigram index over each with_text source's normalized values, one row
// per (source, row) at rowid source_id * 2^40 + rid. It only finds
// candidates: every candidate is checked against the text lookup_keys keeps
// (services/lookup-probe.ts), so what counts as a match is decided in
// JavaScript, exactly as lib/lookup/normalize.ts says. Contentless: removing a
// row names the text it holds.
import { db } from '../lib/db';
import { ftsString } from '../lib/lookup/normalize';

const BASE = 2n ** 40n;

export const textRowid = (sourceId: number, rid: number): bigint => BigInt(sourceId) * BASE + BigInt(rid);
export const ridOfText = (rowid: bigint, sourceId: number): number => Number(rowid - BigInt(sourceId) * BASE);

export function addText(sourceId: number, rid: number, text: string): void {
  db.prepare('INSERT INTO lookup_text (rowid, t) VALUES (?, ?)').run(textRowid(sourceId, rid), text);
}

export function removeText(sourceId: number, rid: number, text: string): void {
  db.prepare("INSERT INTO lookup_text (lookup_text, rowid, t) VALUES ('delete', ?, ?)")
    .run(textRowid(sourceId, rid), text);
}

// How many of a source's rows hold a trigram, counted up to `cap` (a capped
// count reads at most cap+1 entries, where an exact one would read a common
// trigram's whole list). It only steers which trigrams are matched first
// (services/lookup-probe.ts reads every candidate either way), so an old count
// does no harm: counts are kept for the life of the process (up to a bound),
// except none, which is counted again each time (the trigram may have come).
const trigramRowsSeen = new Map<string, number>();
const TRIGRAM_COUNTS_KEPT = 200_000;

export function trigramRows(sourceId: number, trigram: string, cap: number): number {
  const seen = `${sourceId}\u0000${trigram}`;
  const known = trigramRowsSeen.get(seen);
  if (known !== undefined) return known;
  const n = db.prepare(`SELECT count(*) FROM (SELECT rowid FROM lookup_text WHERE lookup_text MATCH ?
    AND rowid > ? AND rowid < ? LIMIT ?)`).pluck()
    .get(ftsString(trigram), textRowid(sourceId, 0), textRowid(sourceId + 1, 0), cap + 1) as number;
  if (n === 0) return 0;
  if (trigramRowsSeen.size >= TRIGRAM_COUNTS_KEPT) trigramRowsSeen.clear();
  trigramRowsSeen.set(seen, n);
  return n;
}

// Rows of a source whose text may contain the needle, in rid order after
// `afterRid`, at most `limit`: rows holding every trigram of `query` (an FTS5
// query, built by the caller from the needle).
export function textCandidates(sourceId: number, query: string, afterRid: number, limit: number): number[] {
  const rows = db.prepare(`SELECT rowid FROM lookup_text WHERE lookup_text MATCH ? AND rowid > ? AND rowid < ?
    ORDER BY rowid LIMIT ?`).pluck().safeIntegers()
    .all(query, textRowid(sourceId, afterRid), textRowid(sourceId + 1, 0), limit) as bigint[];
  return rows.map(r => ridOfText(r, sourceId));
}

// The FTS5 query for a needle: the whole needle as a phrase (its trigrams in
// order), or, given the few rarest trigrams, those ANDed (a superset: the
// caller checks each candidate).
export const phraseQuery = (needle: string): string => ftsString(needle);
export const trigramsQuery = (trigrams: string[]): string => trigrams.map(ftsString).join(' AND ');
