// The rows of a sheet copy (services/sheet-copy.ts), journaled in
// sheet_copy_jobs (migration 047). Each slice reads the source's next rows in
// row order and adds them to the new sheet, cursor and all, in one short
// transaction (lib/slices.ts), so a restart goes on from the last slice and
// never adds a row twice (resumeSheetCopies at boot). The new rows get
// time-ordered ids (lib/ordered-id.ts), which keep each slice's commit small.
// The copy runs with the new sheet busy and the source held for reading
// (lib/sheet-busy.ts): the source can't be sorted, have rows moved or columns
// renamed under the cursor, while edits and new rows go on. Only the rows it
// had at the start are copied (by rowid), never more than were counted then,
// so the copy stays in its reserved range. A slice that fails is tried again,
// waiting longer each time; after SHEET_COPY_ATTEMPTS failures in a row the
// copy stops with the rows it has, and says so.
import { db } from '../lib/db';
import {
  HEAVY_JOB_RETRY_MAX_MS, HEAVY_JOB_RETRY_MS, HEAVY_SLICE_ROWS, SHEET_COPY_ATTEMPTS, SHEET_COPY_SLICE_CHARS,
} from '../lib/constants';
import { runInSlices } from '../lib/slices';
import { stayBusyToFinish, whenSheetFree, withSheetRead } from '../lib/sheet-busy';
import { copiedCells } from '../lib/sheet-copy';
import { orderedUuid } from '../lib/ordered-id';
import { countOf, rewriteSheetChange } from '../lib/change-log';

// What the two sheets are busy with, as their busy message says.
export const COPYING_INTO = 'filling with copied values';
export const BEING_COPIED = 'being copied';

export interface SheetCopyJob {
  sheet_id: string; user_id: string; source_sheet_id: string; columns: string; end_row: number;
  max_rowid: number; row_count: number; after_row: number | null; copied: number; change_id: number | null;
}

const loadJob = (sheetId: string) =>
  db.prepare('SELECT * FROM sheet_copy_jobs WHERE sheet_id = ?').get(sheetId) as SheetCopyJob | undefined;

// The rows copied, or why the copy stopped before the end.
export type CopyEnd = { copied: number; stopped: string | null };

// Copies what is left of the job; call with the new sheet busy and the source
// held. retryMs: the first wait after a failed slice (doubling).
export async function runSheetCopy(sheetId: string, retryMs = HEAVY_JOB_RETRY_MS): Promise<CopyEnd> {
  const job = loadJob(sheetId);
  if (!job) return { copied: 0, stopped: null };
  const columns = JSON.parse(job.columns) as string[];
  const read = db.prepare(`SELECT row_index AS i, data FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index > ? AND row_index <= ? AND rowid <= ? ORDER BY row_index LIMIT ?`);
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)');
  const advance = db.prepare('UPDATE sheet_copy_jobs SET after_row = ?, copied = ? WHERE sheet_id = ?');
  // One slice: up to HEAVY_SLICE_ROWS rows or SHEET_COPY_SLICE_CHARS of their data. True while more are left.
  const slice = db.transaction((): boolean => {
    const at = loadJob(sheetId)!;
    const left = Math.min(HEAVY_SLICE_ROWS, job.row_count - at.copied);
    if (left <= 0) return false;
    const rows: Array<{ i: number; data: string }> = [];
    let chars = 0;
    const from = at.after_row ?? Number.MIN_SAFE_INTEGER;
    for (const r of read.iterate(job.source_sheet_id, job.user_id, from, job.end_row, job.max_rowid, left)) {
      const row = r as { i: number; data: string };
      rows.push(row);
      chars += row.data.length;
      if (chars >= SHEET_COPY_SLICE_CHARS) break;
    }
    if (rows.length === 0) return false;
    let next = at.copied;
    for (const row of rows) {
      const cells = copiedCells(parseRow(row.data), columns);
      insert.run(orderedUuid(), sheetId, job.user_id, next++, JSON.stringify(cells));
    }
    advance.run(rows[rows.length - 1].i, next, sheetId);
    return true;
  });
  let failed = 0;
  let wait = retryMs;
  let copiedAtFailure = -1;
  for (;;) {
    try {
      await runInSlices(() => slice.immediate());
      return finishCopy(sheetId, null);
    } catch (error) {
      // Failures count in a row: one after rows went in starts the count again.
      const copied = loadJob(sheetId)?.copied ?? 0;
      if (copied !== copiedAtFailure) { failed = 0; wait = retryMs; copiedAtFailure = copied; }
      failed++;
      console.error(`Copying values into sheet ${sheetId} failed (${failed} in a row):`, error);
      if (failed >= SHEET_COPY_ATTEMPTS) {
        // Every row in, only finishing failed: it isn't a copy that stopped.
        const stopped = copied >= job.row_count ? null : (error as Error).message || String(error);
        return finishOrKeepTrying(sheetId, stopped);
      }
      await new Promise(resolve => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, HEAVY_JOB_RETRY_MAX_MS);
    }
  }
}

function parseRow(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

// The journal goes, open tabs of the new sheet reload, and its History line
// says what was copied (rows deleted from the source meanwhile aren't), or
// where the copy stopped.
function finishCopy(sheetId: string, error: string | null): CopyEnd {
  const job = loadJob(sheetId);
  if (!job) return { copied: 0, stopped: error };
  db.transaction(() => {
    db.prepare('DELETE FROM sheet_copy_jobs WHERE sheet_id = ?').run(sheetId);
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(sheetId, job.user_id);
    if (job.change_id !== null && (error || job.copied !== job.row_count)) {
      const logged = db.prepare('SELECT detail FROM sheet_changes WHERE id = ?').pluck().get(job.change_id) as
        string | undefined;
      const detail = logged ? JSON.parse(logged) as Record<string, unknown> : {};
      const from = String(detail.from_name ?? '');
      const summary = error
        ? `Copying the values of "${from}" stopped after ${countOf(job.copied, 'row')} of `
          + `${job.row_count.toLocaleString('en-US')}: ${error}`
        : `Copied the values of ${countOf(job.copied, 'row')} from "${from}"`;
      rewriteSheetChange(job.change_id, summary, { ...detail, rows: job.copied, ...(error ? { stopped: error } : {}) });
    }
  }).immediate();
  return { copied: job.copied, stopped: error };
}

// finishCopy, and if that fails too, the new sheet stays busy (its journal
// would read as a copy still going) while it is tried again in the background.
function finishOrKeepTrying(sheetId: string, error: string | null): CopyEnd {
  try {
    return finishCopy(sheetId, error);
  } catch (failure) {
    stayBusyToFinish(sheetId, COPYING_INTO, async () => { finishCopy(sheetId, error); });
    throw failure;
  }
}

// At boot: every copy a restart cut short goes on from its cursor. Call before
// serving a request: each new sheet is marked busy synchronously.
export function resumeSheetCopies(): void {
  for (const job of db.prepare('SELECT * FROM sheet_copy_jobs').all() as SheetCopyJob[]) {
    console.warn(`⚠️ Copying values into sheet ${job.sheet_id} was cut short by a restart; going on.`);
    whenSheetFree(job.sheet_id, COPYING_INTO, async reserve => {
      reserve(job.row_count);
      await copyHoldingSource(job);
    }).catch(err => console.error(`Copying values into sheet ${job.sheet_id} failed:`, err));
  }
}

// runSheetCopy with the source held for reading, waiting while another job holds it.
export async function copyHoldingSource(job: SheetCopyJob): Promise<CopyEnd> {
  for (;;) {
    const out = await withSheetRead(job.source_sheet_id, () => runSheetCopy(job.sheet_id), BEING_COPIED);
    if (!('busy' in out)) return out;
    await new Promise(resolve => setTimeout(resolve, HEAVY_JOB_RETRY_MS));
  }
}
