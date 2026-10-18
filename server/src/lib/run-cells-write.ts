// A run's cells in one row, and the stamp of the inputs they were made from
// (lib/run-inputs/stamp.ts), in one UPDATE: a result and what it was made from
// are never written apart. Every run writer goes through it (AI, structured AI,
// HTTP API, enrichment and waterfall rows, a promoted AI preview); call it
// inside the result's write transaction. Without a stamp, run_inputs stays.
// What the cells held before the run is kept first, so the run can be undone
// (lib/run-undo/journal.ts); a run once undone writes nothing (false).
import { db } from './db';
import { jsonPath } from './json-path';
import type { RowStamp } from './run-inputs/stamp';
import { journalRowWrite, type RunRef } from './run-undo/journal';

export function writeRunCells(
  run: RunRef, sheetId: string, userId: string, rowIndex: number, cells: Array<[string, string]>, stamp?: RowStamp,
): boolean {
  if (cells.length === 0) return true;
  if (!journalRowWrite(run, sheetId, userId, rowIndex, cells, stamp?.path ?? null)) return false;
  db.prepare(`
    UPDATE rows SET data = json_set(data, ${cells.map(() => '?, ?').join(', ')}),
      run_inputs = CASE WHEN ? IS NULL THEN run_inputs ELSE json_set(COALESCE(run_inputs, '{}'), ?, ?) END,
      updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND row_index = ?
  `).run(
    ...cells.flatMap(([column, value]) => [jsonPath(column), value]),
    stamp?.path ?? null, stamp?.path ?? null, stamp?.fp ?? null, sheetId, userId, rowIndex,
  );
  return true;
}
