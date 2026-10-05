import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { HEAVY_SLICE_ROWS } from './constants';
import { runInSlices } from './slices';
import { stayBusyToFinish, whenSheetFree } from './sheet-busy';

// A CSV import in progress, as journaled in import_jobs (migration 004): its
// rows go in at first_row up to end_row, and appends from elsewhere land at
// end_row or above. A replace also deletes the old rows, all below end_row.
export interface ImportJob {
  sheet_id: string; user_id: string; is_replace: number;
  first_row: number; end_row: number; columns: string;
}

// Deletes the sheet's rows with first <= row_index < end, a slice at a time.
export async function deleteRowRange(sheetId: string, userId: string, first: number, end: number): Promise<void> {
  const slice = db.prepare(`
    DELETE FROM rows WHERE rowid IN (
      SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= ? AND row_index < ?
      ORDER BY row_index LIMIT ?
    )`);
  await runInSlices(() => slice.run(sheetId, userId, first, end, HEAVY_SLICE_ROWS).changes > 0);
}

// Deletes every stored AI/HTTP result of the sheet's runs, a slice at a time.
export async function purgeSheetResults(sheetId: string, userId: string): Promise<void> {
  const slices = [
    db.prepare(`
      DELETE FROM ai_results WHERE rowid IN (
        SELECT rowid FROM ai_results WHERE run_id IN (SELECT id FROM ai_runs WHERE sheet_id = ? AND user_id = ?) LIMIT ?
      )`),
    db.prepare(`
      DELETE FROM http_results WHERE rowid IN (
        SELECT rowid FROM http_results WHERE run_id IN (SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ?) LIMIT ?
      )`),
  ];
  for (const slice of slices) {
    await runInSlices(() => slice.run(sheetId, userId, HEAVY_SLICE_ROWS).changes > 0);
  }
}

// The column list a replace leaves: the file's columns, then any held by rows
// that arrived above the import's range while it ran (webhook deliveries
// listed them meanwhile; replacing the list must not hide them). Those rows
// are few, so this never reads the imported ones.
export function replaceColumnOrder(job: ImportJob): string {
  const columns = JSON.parse(job.columns) as string[];
  const listed = new Set(columns);
  const above = db.prepare(`
    SELECT DISTINCT je.key FROM rows r, json_each(r.data) je
    WHERE r.sheet_id = ? AND r.user_id = ? AND r.row_index >= ?
  `).pluck().all(job.sheet_id, job.user_id, job.end_row) as string[];
  return JSON.stringify([...columns, ...above.filter(k => !listed.has(k))]);
}

// Removes what an import that failed or was cut short had written. An append
// leaves the sheet as it was before; a replace, whose old rows may already be
// gone, leaves the sheet empty with the file's columns and one row to type in.
// Then forgets the journal. Call while holding the sheet busy.
export async function undoImport(job: ImportJob): Promise<void> {
  await deleteRowRange(job.sheet_id, job.user_id, job.first_row, job.end_row);
  if (job.is_replace) await purgeSheetResults(job.sheet_id, job.user_id);
  db.transaction(() => {
    if (job.is_replace) {
      db.prepare(
        `UPDATE sheets SET column_order = ?, empty_filter = NULL, column_filters = NULL,
           row_generation = row_generation + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
      ).run(replaceColumnOrder(job), job.sheet_id, job.user_id);
      if (!db.prepare('SELECT 1 FROM rows WHERE sheet_id = ? AND user_id = ? LIMIT 1').get(job.sheet_id, job.user_id)) {
        db.prepare("INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, 0, '{}')")
          .run(uuidv4(), job.sheet_id, job.user_id);
      }
    }
    db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(job.sheet_id, job.user_id);
    db.prepare('DELETE FROM import_jobs WHERE sheet_id = ?').run(job.sheet_id);
  })();
}

// undoImport, and if that fails too, keep the sheet busy and retry it in the
// background (lib/sheet-busy.ts) rather than release half-imported rows.
export async function undoOrKeepTrying(job: ImportJob): Promise<void> {
  try {
    await undoImport(job);
  } catch (error) {
    stayBusyToFinish(job.sheet_id, 'cleaning up an import', () => undoImport(job));
    throw error;
  }
}

// At boot: undo every import a restart cut short. Call right after the server
// starts listening, before it serves a request: each sheet is marked busy, and
// appends kept above the import's range, synchronously.
export function resumeImports(): void {
  for (const job of db.prepare('SELECT * FROM import_jobs').all() as ImportJob[]) {
    console.warn(`⚠️ A CSV import into sheet ${job.sheet_id} was cut short by a restart; removing its rows.`);
    whenSheetFree(job.sheet_id, 'cleaning up an import', reserve => {
      reserve(job.end_row);
      return undoOrKeepTrying(job);
    }).catch(err => console.error(`Cleaning up the import into sheet ${job.sheet_id} failed:`, err));
  }
}
