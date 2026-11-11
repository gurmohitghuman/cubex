// transform_column's walk over the sheet (services/column-transform.ts), in row
// order from the cursor: a page of TRANSFORM_PAGE_ROWS rows at a time, each page
// read, worked out and written in one short immediate transaction, the server
// answering other requests between pages (lib/slices.ts). One page of rows is in
// memory at a time, whatever the sheet's size. A page first reads its window off
// the (sheet_id, user_id, row_index) index, then only the rows in that window
// that pass `where`: a where that matches nothing still looks at one window a
// page, never the rest of the sheet in one statement. The call stops before a
// page once it has written TRANSFORM_MAX_ROWS rows or worked TRANSFORM_MAX_CALL_MS;
// every page before that is written and stays written.
import { db } from '../lib/db';
import {
  TRANSFORM_MAX_CALL_MS, TRANSFORM_MAX_ROWS, TRANSFORM_PAGE_ROWS, TRANSFORM_QUEUED_ROWS,
} from '../lib/api-v1-constants';
import { jsonPath, parseRowData } from '../lib/sql-helpers';
import { autorunReaderCount, markAutorunInputs } from '../lib/autorun-mark';
import { runInCheckpointedRowSlices, runInSlices } from '../lib/slices';
import type { CompiledFilter } from '../lib/row-filter/sql';

export interface TransformWalk {
  sheetId: string; userId: string; filter: CompiledFilter; targetColumn: string;
  // The target's new value for a row, from its cells.
  value: (data: Record<string, string>) => string;
  // The row_index the walk starts after (the cursor's; -1 from the top).
  after: number;
}

// Rows written, and the last row_index looked at when the call stopped with rows
// left (null: it got to the end of the sheet).
export interface WalkResult { updated: number; stoppedAfter: number | null }

export async function walkTransform(w: TransformWalk): Promise<WalkResult> {
  // With columns following the target, a page queues each row it writes for each
  // of them: sized by queued rows, each committed with SQLite's own checkpoint off
  // and checkpointed in a turn of its own (lib/slices.ts).
  const readers = autorunReaderCount(w.sheetId, w.userId, [w.targetColumn]);
  const pageRows = readers === 0 ? TRANSFORM_PAGE_ROWS
    : Math.max(1, Math.min(TRANSFORM_PAGE_ROWS, Math.floor(TRANSFORM_QUEUED_ROWS / (1 + readers))));
  const windowEnd = db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index LIMIT 1 OFFSET ?`).pluck();
  const read = db.prepare(`SELECT rowid AS rid, data FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index > ? AND row_index <= ? AND (${w.filter.sql}) ORDER BY rowid`);
  const set = db.prepare("UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now') WHERE rowid = ?");
  const path = jsonPath(w.targetColumn);
  const startedAt = Date.now();
  let after = w.after;
  let updated = 0;
  let done = false;
  const page = db.transaction((rows: number): void => {
    const last = windowEnd.get(w.sheetId, w.userId, after, rows - 1) as number | undefined;
    const found = read.all(w.sheetId, w.userId, after, last ?? Number.MAX_SAFE_INTEGER, ...w.filter.params) as
      Array<{ rid: number; data: string }>;
    for (const r of found) set.run(path, w.value(parseRowData(r.data)), r.rid);
    // A column another column's auto-run reads queues these rows for it.
    markAutorunInputs(w.sheetId, w.userId, [w.targetColumn], { rowids: found.map(r => r.rid) });
    updated += found.length;
    if (last === undefined) done = true;
    else after = last;
  });
  const step = (): boolean => {
    const room = TRANSFORM_MAX_ROWS - updated;
    if (room <= 0 || Date.now() - startedAt >= TRANSFORM_MAX_CALL_MS) return false;
    // A page never looks at more rows than the call may still write.
    page.immediate(Math.min(pageRows, room));
    return !done;
  };
  await (readers > 0 ? runInCheckpointedRowSlices(step) : runInSlices(step));
  return { updated, stoppedAfter: done ? null : after };
}
