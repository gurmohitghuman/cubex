// Rows a stopped run's ⏳ clear told the clean, formula and lookup columns reading its columns
// (lib/placeholder-cells.ts), as spans (migration 060): one record per slice of the clear, its told rowids in
// storage order, and a mark per reader saying how far it got. Queuing each told row for each reader cost a page
// write per row and reader, so with 20 readers a clear of 200,000 rows held the run's columns for minutes; a span
// costs the same with 0 or 20 readers. Readers start on a span once its run's clear has ended (the clear and the
// readers would otherwise take turns slice by slice, and the clear would again last as long as they do), then
// work its rows out in storage order (services/derived-follow.ts). Marks live as the queue does: a reader turned
// off keeps them, a deleted reader (the cascade), a CSV replace and a sheet's purge drop them
// (lib/autorun-mark.ts), and a span goes with its last mark (a trigger).
import { db } from './db';
import { followQueued } from './autorun-kick';
import type { RunRef } from './run-undo/journal';

// Inside the clear slice's transaction: `rowids` (ascending) were told to `readers` (lib/autorun-mark.ts
// derivedReaderIds, read in that transaction). The clear kicks them when it ends (kickSpanReaders).
export function tellDerivedSpan(
  sheetId: string, userId: string, readers: string[], rowids: number[], run?: RunRef,
): void {
  if (rowids.length === 0 || readers.length === 0) return;
  const id = db.prepare(`INSERT INTO derived_spans (user_id, sheet_id, run_kind, run_id, rowids)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).pluck()
    .get(userId, sheetId, run?.kind ?? null, run?.id ?? null, JSON.stringify(rowids)) as number;
  const mark = db.prepare('INSERT INTO derived_span_marks (autorun_id, span_id) VALUES (?, ?)');
  for (const reader of readers) mark.run(reader, id);
}

// A clear on the sheet has ended: every reader with spans there looks again, those waiting for this clear and
// those waiting at a row another run held (services/derived-follow.ts). API process only (followQueued); a run
// worker's clear leaves them to the auto-run sweep.
export function kickSpanReaders(sheetId: string): void {
  const readers = db.prepare(`SELECT DISTINCT autorun_id FROM derived_span_marks
    WHERE span_id IN (SELECT id FROM derived_spans WHERE sheet_id = ?)`).pluck().all(sheetId) as string[];
  for (const reader of readers) followQueued(reader);
}

// Whether the entry has spans left (autorun-fence.ts hasWork, a setup step's progress).
export const hasSpanWork = (entryId: string): boolean =>
  !!db.prepare('SELECT 1 FROM derived_span_marks WHERE autorun_id = ? LIMIT 1').get(entryId);

export interface SpanMark { spanId: number; done: number; rowids: number[] }

const clearing = (kind: string, id: string): boolean => !!db.prepare(
  `SELECT 1 FROM ${kind === 'ai' ? 'ai_runs' : 'http_runs'} WHERE id = ? AND placeholder_work IS NOT NULL`,
).get(id);

// The entry's oldest span, unless its run's clear is still going (the readers wait for it). Call inside a slice.
export function nextSpan(entryId: string): SpanMark | null {
  const m = db.prepare(`SELECT m.span_id AS spanId, m.done AS done, s.rowids AS rowids, s.run_kind AS kind,
      s.run_id AS run
    FROM derived_span_marks m JOIN derived_spans s ON s.id = m.span_id
    WHERE m.autorun_id = ? ORDER BY m.span_id LIMIT 1`).get(entryId) as
    { spanId: number; done: number; rowids: string; kind: string | null; run: string | null } | undefined;
  if (!m || (m.kind && m.run && clearing(m.kind, m.run))) return null;
  return { spanId: m.spanId, done: m.done, rowids: JSON.parse(m.rowids) as number[] };
}

// The entry got `done` rows into the span: at its end the mark goes (and the span with its last mark).
export function spanWorked(entryId: string, span: SpanMark, done: number): void {
  if (done >= span.rowids.length) {
    db.prepare('DELETE FROM derived_span_marks WHERE autorun_id = ? AND span_id = ?').run(entryId, span.spanId);
  } else if (done > span.done) {
    db.prepare('UPDATE derived_span_marks SET done = ? WHERE autorun_id = ? AND span_id = ?')
      .run(done, entryId, span.spanId);
  }
}
