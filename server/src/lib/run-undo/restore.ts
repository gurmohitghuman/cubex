// One slice of an undo (services/run-undo.ts runs them, a turn apart): the
// next journal rows in rowid order (storage order, lib/row-order.ts), their
// cells put back in one write transaction with the cursor and the counts, so
// a restart goes on from the cursor. Each cell is written in SQL over the row
// as it is (json_set/json_remove of its own path), never the whole row from
// here, so a run filling another column of the same rows loses nothing.
import type { Statement } from 'better-sqlite3';
import { db } from '../db';
import { jsonPath } from '../json-path';
import { parseRowData } from '../sql-rows';
import { markDerivedInputs } from '../autorun-mark';
import { isEmptyCell, isListWords, oldValueOf, undoOutcome, type JournalCell } from './print';

export interface UndoJob {
  id: number; sheetId: string; userId: string;
  columns: Array<string | null>;   // the journal's slots (null: the column was deleted)
  main: string | null;             // the run's main column now: its old run_inputs entry comes back with it
  stampPath: string | null;        // that entry's key, while the column keeps it
}

interface Rec { row_id: number; ref: string; stamp: string | null; cells: string }
interface Row { rid: number; id: string; data: string }
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

// Returns whether journal rows are left after this slice.
export function undoSlice(job: UndoJob, limit: number): boolean {
  return db.transaction((): boolean => {
    const head = db.prepare('SELECT cursor, state FROM run_undos WHERE id = ?').get(job.id) as
      { cursor: number; state: string } | undefined;
    if (head?.state !== 'undoing') return false;
    const recs = db.prepare(`SELECT row_id, ref, stamp, cells FROM run_undo_rows WHERE undo_id = ? AND row_id > ?
      ORDER BY row_id LIMIT ?`).all(job.id, head.cursor, limit) as Rec[];
    if (recs.length === 0) return false;
    const rows = new Map((db.prepare(`SELECT rowid AS rid, id, data FROM rows
      WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`)
      .all(JSON.stringify(recs.map(r => r.row_id)), job.sheetId, job.userId) as Row[]).map(r => [r.rid, r]));
    let restored = 0, skipped = 0, gone = 0;
    const columns = new Set<string>(), rowids: number[] = [];
    const listPending = db.prepare(`SELECT 1 FROM enrichment_list_items WHERE source_row_id = ? AND user_id = ?
      AND status = 'pending' LIMIT 1`);
    for (const rec of recs) {
      const cells = JSON.parse(rec.cells) as JournalCell[];
      const row = rows.get(rec.row_id);
      // Deleted since (a rowid SQLite handed to a newer row has another id).
      if (!row || row.id.slice(0, 8) !== rec.ref) { gone += cells.length; continue; }
      const data = parseRowData(row.data);
      const w: Write = { rid: row.rid, sets: [], removes: [], stamp: null };
      let mainBack = false;
      for (const cell of cells) {
        const name = job.columns[cell[0]] ?? null;
        if (name === null) { gone++; continue; }
        let old = oldValueOf(cell);
        if (isListWords(old) && !listPending.get(row.id, job.userId)) old = null;
        const outcome = undoOutcome(data[name], cell, old);
        if (outcome === 'skip') { skipped++; continue; }
        restored++;
        if (name === job.main) mainBack = true;
        if (outcome === 'same') continue;
        if (isEmptyCell(old)) w.removes.push(jsonPath(name)); else w.sets.push(jsonPath(name), JSON.stringify(old));
        columns.add(name);
      }
      if (mainBack && job.stampPath !== null && rec.stamp !== null) w.stamp = rec.stamp;
      if (!w.sets.length && !w.removes.length && w.stamp === null) continue;
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
    }
    db.prepare(`UPDATE run_undos SET cursor = ?, restored = restored + ?, skipped = skipped + ?, gone = gone + ?
      WHERE id = ?`).run(recs[recs.length - 1].row_id, restored, skipped, gone, job.id);
    markDerivedInputs(job.sheetId, job.userId, columns, { rowids });
    return recs.length === limit;
  }).immediate();
}
