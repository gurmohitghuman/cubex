// Undo journals (migration 041) go for good, a slice at a time, never holding
// the server: one kept UNDO_KEEP_DAYS after its run started (once the run has
// stopped), and an undone one's rows as soon as it is done (its counts stay
// until it is that old). The trash's sweep calls pruneRunUndos every
// TRASH_SWEEP_MS (services/trash-purge.ts), an undo kicks it when it ends, and
// a sheet emptied from the trash drops its journals first (dropSheetUndos).
import { db } from '../lib/db';
import { UNDO_DROP_SLICE_ROWS, UNDO_KEEP_DAYS } from '../lib/constants';
import { runInCheckpointedSlices } from '../lib/slices';

// A run that may still write: going, or clearing its ⏳.
const goes = (table: string, kind: string) => `EXISTS (SELECT 1 FROM ${table} r WHERE run_undos.run_kind = '${kind}'
  AND r.id = run_undos.run_id AND (r.status IN ('pending', 'running', 'paused') OR r.placeholder_work IS NOT NULL))`;

// One sweep at a time; asked during one, it looks again after, and the
// promise answered is the sweep's (so the asker waits for what it asked).
let sweeping: Promise<void> | null = null;
let again = false;

export function pruneRunUndos(): Promise<void> {
  if (sweeping) { again = true; return sweeping; }
  sweeping = (async () => {
    try {
      do { again = false; await sweep(); } while (again);
    } finally { sweeping = null; }
  })();
  return sweeping;
}

async function sweep(): Promise<void> {
  db.prepare(`UPDATE run_undos SET state = 'dropping' WHERE state IN ('kept', 'undone')
    AND created_at <= datetime('now', ?) AND NOT ${goes('ai_runs', 'ai')} AND NOT ${goes('http_runs', 'http')}`)
    .run(`-${UNDO_KEEP_DAYS} days`);
  const due = db.prepare(`SELECT id, state FROM run_undos WHERE state = 'dropping'
    OR (state = 'undone' AND EXISTS (SELECT 1 FROM run_undo_rows WHERE undo_id = run_undos.id))`)
    .all() as Array<{ id: number; state: string }>;
  for (const j of due) {
    await dropRows(j.id);
    if (j.state === 'dropping') db.prepare("DELETE FROM run_undos WHERE id = ? AND state = 'dropping'").run(j.id);
  }
}

// An undo just ended: its rows go now, in the background.
export function kickUndoDrops(): void {
  pruneRunUndos().catch(err => console.error('Dropping undo journals failed (tried again later):', err));
}

// A journal's rows in their own order: each slice deletes neighbouring pages.
async function dropRows(undoId: number): Promise<void> {
  const slice = db.prepare(`DELETE FROM run_undo_rows WHERE undo_id = ? AND row_id IN (SELECT row_id
    FROM run_undo_rows WHERE undo_id = ? ORDER BY row_id LIMIT ?)`);
  await runInCheckpointedSlices(() => slice.run(undoId, undoId, UNDO_DROP_SLICE_ROWS).changes === UNDO_DROP_SLICE_ROWS);
}

// A sheet going for good (services/trash-purge.ts, before the sheet itself):
// the journals of its runs, then their records.
export async function dropSheetUndos(sheetId: string): Promise<void> {
  const ids = db.prepare('SELECT id FROM run_undos WHERE sheet_id = ?').pluck().all(sheetId) as number[];
  for (const id of ids) await dropRows(id);
  db.prepare('DELETE FROM run_undos WHERE sheet_id = ?').run(sheetId);
}
