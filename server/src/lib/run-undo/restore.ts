// One slice of an undo (services/run-undo.ts runs them, a turn apart): the
// next journal rows in rowid order (storage order, lib/row-order.ts), their
// cells put back in one write transaction with the cursor and the counts, so
// a restart goes on from the cursor. Each cell is written in SQL over the row
// as it is (json_set/json_remove of its own path), never the whole row from
// here, so a run filling another column of the same rows loses nothing. A
// row whose main cell came back no longer holds the run's answer: its result
// is marked undone in the same transaction (migration 044).
import type { Statement } from 'better-sqlite3';
import { db } from '../db';
import { jsonPath } from '../json-path';
import { parseRowData } from '../sql-rows';
import { markDerivedInputs } from '../autorun-mark';
import { isEmptyCell, isListWords, oldValueOf, undoOutcome, type JournalCell } from './print';
import type { RunRef } from './journal';

export interface UndoJob {
  id: number; sheetId: string; userId: string; run: RunRef;
  columns: Array<string | null>;   // the journal's slots (null: the column was deleted)
  main: string | null;             // the run's main column now: its old run_inputs entry comes back with it
  stampPath: string | null;        // that entry's key, while the column keeps it
}

interface Rec { row_id: number; ref: string; stamp: string | null; cells: string }
interface Row { rid: number; id: string; ri: number; data: string }
interface Write { rid: number; sets: string[]; removes: string[]; stamp: string | null }

// The row's update, one statement per shape (how many cells set and emptied, the stamp).
const shapes = new Map<string, Statement>();
function writeRow(w: Write, stampPath: string | null): void {
  const key = `${w.sets.length}/${w.removes.length}/${w.stamp === null ? '-' : w.stamp === 'null' ? '0' : '1'}`;
  let stmt = shapes.get(key);
  if (!stmt) {
    let data = 'data';
    if (w.sets.length) data = `json_set(${data}${', ?, json(?)'.repeat(w.sets.length / 2)})`;
    if (w.removes.length) data = `json_remove(${data}${', ?'.repeat(w.removes.length)})`;
    const inputs = w.stamp === null ? 'run_inputs'
      : w.stamp === 'null' ? 'json_remove(run_inputs, ?)' : "json_set(COALESCE(run_inputs, '{}'), ?, json(?))";
    stmt = db.prepare(`UPDATE rows SET data = ${data}, run_inputs = ${inputs}, updated_at = datetime('now')
      WHERE rowid = ?`);
    shapes.set(key, stmt);
  }
  const stampArgs = w.stamp === null ? [] : w.stamp === 'null' ? [stampPath] : [stampPath, w.stamp];
  stmt.run(...w.sets, ...w.removes, ...stampArgs, w.rid);
}

// The run's results at rows whose answer the undo took back: no longer the
// cell's answer (services/answer-runs.ts, routes/ai-read.ts, answer-field-fill.ts)
// and never reused for free (an enrichment's reuse_key goes: services/enrich-reuse.ts).
const MARK_UNDONE: Record<RunRef['kind'], string> = {
  ai: `UPDATE ai_results SET undone = 1
    WHERE run_id = ? AND row_index IN (SELECT value FROM json_each(?)) AND +user_id = ?`,
  http: `UPDATE http_results SET undone = 1, reuse_key = NULL
    WHERE run_id = ? AND row_index IN (SELECT value FROM json_each(?)) AND +user_id = ?`,
};

// Returns whether journal rows are left after this slice.
export function undoSlice(job: UndoJob, limit: number): boolean {
  return db.transaction((): boolean => {
    const head = db.prepare('SELECT cursor, state FROM run_undos WHERE id = ?').get(job.id) as
      { cursor: number; state: string } | undefined;
    if (head?.state !== 'undoing') return false;
    const recs = db.prepare(`SELECT row_id, ref, stamp, cells FROM run_undo_rows WHERE undo_id = ? AND row_id > ?
      ORDER BY row_id LIMIT ?`).all(job.id, head.cursor, limit) as Rec[];
    if (recs.length === 0) return false;
    const rows = new Map((db.prepare(`SELECT rowid AS rid, id, row_index AS ri, data FROM rows
      WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`)
      .all(JSON.stringify(recs.map(r => r.row_id)), job.sheetId, job.userId) as Row[]).map(r => [r.rid, r]));
    let restored = 0, skipped = 0, gone = 0;
    const columns = new Set<string>(), rowids: number[] = [], answersBack: number[] = [];
    // A list job of this column whose results are still on their way to the row (another
    // column's list job pending there wouldn't ever replace these words).
    const listPending = db.prepare(`SELECT 1 FROM enrichment_list_items li
        JOIN http_runs r ON r.id = li.run_id AND r.master_column_name = ? AND r.sheet_id = li.source_sheet_id
      WHERE li.source_row_id = ? AND li.source_sheet_id = ? AND li.user_id = ? AND li.status = 'pending' LIMIT 1`);
    // Whose answer the row held: the main cell's, or (that column deleted) any of the run's cells.
    const mainKept = job.main !== null && job.columns.includes(job.main);
    for (const rec of recs) {
      const cells = JSON.parse(rec.cells) as JournalCell[];
      const row = rows.get(rec.row_id);
      // Deleted since (a rowid SQLite handed to a newer row has another id).
      if (!row || row.id.slice(0, 8) !== rec.ref) { gone += cells.length; continue; }
      const data = parseRowData(row.data);
      const w: Write = { rid: row.rid, sets: [], removes: [], stamp: null };
      let mainBack = false, anyBack = false;
      for (const cell of cells) {
        const name = job.columns[cell[0]] ?? null;
        if (name === null) { gone++; continue; }
        let old = oldValueOf(cell);
        if (isListWords(old) && !listPending.get(name, row.id, job.sheetId, job.userId)) old = null;
        const outcome = undoOutcome(data[name], cell, old);
        if (outcome === 'skip') { skipped++; continue; }
        restored++;
        anyBack = true;
        if (name === job.main) mainBack = true;
        if (outcome === 'same') continue;
        if (isEmptyCell(old)) w.removes.push(jsonPath(name)); else w.sets.push(jsonPath(name), JSON.stringify(old));
        columns.add(name);
      }
      if (mainBack && job.stampPath !== null && rec.stamp !== null) w.stamp = rec.stamp;
      const answerBack = mainKept ? mainBack : anyBack;
      if (!w.sets.length && !w.removes.length && w.stamp === null) {
        if (answerBack) answersBack.push(row.ri);
        continue;
      }
      try {
        writeRow(w, job.stampPath);
      } catch (error) {
        // A row SQLite can't write (its cells unreadable as JSON) stays as it is,
        // its cells counted as skipped, and the undo goes on.
        console.error(`Undo ${job.id}: row ${row.rid} could not be written back:`, (error as Error).message);
        const lost = w.sets.length / 2 + w.removes.length;
        restored -= lost; skipped += lost;
        continue;
      }
      if (w.sets.length || w.removes.length) rowids.push(row.rid);
      if (answerBack) answersBack.push(row.ri);
    }
    if (answersBack.length) {
      db.prepare(MARK_UNDONE[job.run.kind]).run(job.run.id, JSON.stringify(answersBack), job.userId);
    }
    db.prepare(`UPDATE run_undos SET cursor = ?, restored = restored + ?, skipped = skipped + ?, gone = gone + ?
      WHERE id = ?`).run(recs[recs.length - 1].row_id, restored, skipped, gone, job.id);
    markDerivedInputs(job.sheetId, job.userId, columns, { rowids });
    return recs.length === limit;
  }).immediate();
}
