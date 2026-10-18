// Removing duplicate rows: one implementation for the app, /api/v1 and MCP.
// It works out which rows go (dedupe-scan.ts), journals them
// (lib/dedupe/journal.ts) and deletes them a slice at a time, all as the
// sheet's one heavy operation (lib/sheet-busy.ts): other changes to the sheet
// wait, and rows appended meanwhile land above the rows checked and stay.
//
// Refused while a run is active on the sheet, as a sort or a row delete is: a
// worker mid-call would write a result for a row that is gone. The rows left
// keep their positions, but row_generation moves at the end: an open tab's
// autosave writes by position and would bring a deleted row back, so it
// reloads instead. A restart finishes a journaled removal.
import { db } from '../lib/db';
import { countRows, getSheetColumns, touchSheet, verifySheetOwnership } from '../lib/sql-helpers';
import { stayBusyToFinish, whenSheetFree, withSheetBusy } from '../lib/sheet-busy';
import { runInSlices } from '../lib/slices';
import { autorunAfterRemoval } from '../lib/autorun-mark';
import {
  dedupeJobs, dropDedupeChunk, dropDedupeJob, nextDedupeChunk, saveDedupePlan, type DedupeJob,
} from '../lib/dedupe/journal';
import { sheetRunBlock, type BlockingRun, type RunBlock } from './autorun-block';
import { DEDUPE_RUN_ACTIVE, parseDedupeRequest, type DedupeArgs } from './dedupe-input';
import { dedupeReport, type DedupeReport } from './dedupe-report';
import { scanDuplicates } from './dedupe-scan';
import { afterDuplicateChecks } from './dedupe-check';
import type { RunFail } from './run-shared';
import { removeRows, sealBatch } from '../lib/trash/move';
import { dropIfEmpty, openSlicedBatch } from './trash-batch';
import { countOf, logSheetChange } from '../lib/change-log';

const WHAT = 'removing duplicates';

export interface DedupeFail extends RunFail { blockingRun?: BlockingRun; busy?: boolean }
// rowsLeft: the sheet's rows afterwards, rows appended meanwhile included.
// trashId: the trash batch holding the removed rows (null: none removed, or none kept).
export interface DedupeRemoval extends DedupeReport { removed: number; rowsLeft: number; trashId: number | null }
type Work = { blocked: RunBlock } | { done: DedupeRemoval };

export async function removeDuplicates(
  userId: string, sheetId: string, args: DedupeArgs,
): Promise<{ ok: DedupeRemoval } | DedupeFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const parsed = parseDedupeRequest(getSheetColumns(sheetId, userId, false), args);
  if ('fail' in parsed) return parsed;
  const req = parsed.ok;
  const work = async (reserve: (floor: number) => void): Promise<Work> => {
    const block = sheetRunBlock(sheetId, userId, DEDUPE_RUN_ACTIVE);
    if (block) return { blocked: block };
    const leftover = dedupeJobs().find(j => j.sheet_id === sheetId);
    if (leftover) await finishJob(leftover, reserve);
    const top = db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ? AND user_id = ?')
      .pluck().get(sheetId, userId) as number | null;
    const floor = top === null ? 0 : top + 1;
    reserve(floor);
    const found = (await scanDuplicates(sheetId, userId, req, { below: floor }))!;
    const report = dedupeReport(sheetId, userId, req, found);
    let trashId: number | null = null;
    if (found.remove.length > 0) {
      await saveDedupePlan(sheetId, userId, floor, found.remove);
      trashId = await carryOut({
        sheet_id: sheetId, user_id: userId, floor, row_count: found.remove.length, stage: 'deleting',
      });
      const columns = req.keys.map(k => k.column);
      logSheetChange(sheetId, userId, 'duplicates_removed',
        `Removed ${countOf(found.remove.length, 'duplicate row')} (same ${columns.join(' + ')})`,
        { detail: { rows: found.remove.length, columns, keep: req.keep, trash_id: trashId } });
    }
    return { done: { ...report, removed: found.remove.length, rowsLeft: countRows(sheetId, userId), trashId } };
  };
  // A check in progress is stopped, and the sheet taken before another can start.
  const outcome = await afterDuplicateChecks(sheetId, () => withSheetBusy(sheetId, WHAT, work));
  if ('busy' in outcome) return { fail: 'conflict', message: outcome.busy, busy: true };
  if ('blocked' in outcome) {
    return { fail: 'conflict', message: outcome.blocked.message, blockingRun: outcome.blocked.run };
  }
  return { ok: outcome.done };
}

// One chunk: the rows still there under the floor go to the trash batch
// (their AI/HTTP results, stored by position, go: lib/sql-rows.ts), and the
// chunk's record, in one transaction.
function deleteChunk(job: DedupeJob, chunk: number, rowIds: Float64Array, item: number | null): void {
  const live = db.prepare(`SELECT rowid FROM rows WHERE rowid IN (SELECT value FROM json_each(?))
    AND +sheet_id = ? AND +user_id = ? AND row_index < ?`).pluck()
    .all(JSON.stringify(Array.from(rowIds)), job.sheet_id, job.user_id, job.floor) as number[];
  if (live.length > 0) removeRows(job.sheet_id, job.user_id, { rowids: live }, item);
  dropDedupeChunk(job.sheet_id, chunk);
}

// Deletes the journaled rows chunk by chunk, then drops the journal and moves
// the fence. Each chunk is followed, a turn later, by a PASSIVE WAL checkpoint
// of its few hundred pages: left to the auto-checkpoint, a commit now and then
// copied 8 MB back and held the server up to a second (constants-dedupe.ts).
// An error midway moves the fence too (rows are gone) and keeps the sheet busy
// while the rest is retried in the background (lib/sheet-busy.ts).
async function carryOut(job: DedupeJob): Promise<number | null> {
  const fence = () => db.prepare(`UPDATE sheets SET row_generation = row_generation + 1,
    data_version = data_version + 1 WHERE id = ? AND user_id = ?`).run(job.sheet_id, job.user_id);
  // The removed rows' trash batch, the one a restart left filling if any (trash-batch.ts).
  const item = openSlicedBatch(job.sheet_id, job.user_id, 'duplicates');
  let checkpoint = false;
  try {
    await runInSlices(() => {
      if (checkpoint) { db.pragma('wal_checkpoint(PASSIVE)'); checkpoint = false; return true; }
      const next = nextDedupeChunk(job.sheet_id);
      if (!next) return false;
      db.transaction(() => deleteChunk(job, next.chunk, next.rowIds, item))();
      checkpoint = true;
      return true;
    });
    let kept: number | null = null;
    db.transaction(() => {
      dropDedupeJob(job.sheet_id);
      fence();
      autorunAfterRemoval(job.sheet_id, job.user_id);
      touchSheet(job.sheet_id, job.user_id);
      // Sealed after the fence: a restore compares the row_generation it keeps.
      if (item !== null && !dropIfEmpty(item)) { sealBatch(item, job.sheet_id, job.user_id); kept = item; }
    })();
    return kept;
  } catch (error) {
    stayBusyToFinish(job.sheet_id, WHAT, async () => {
      const left = dedupeJobs().find(j => j.sheet_id === job.sheet_id);
      if (left) await carryOut(left);
    });
    try { fence(); } catch { /* the retry fences */ }
    throw error;
  }
}

// A removal still 'planning' deleted nothing: forget it. Otherwise finish it.
async function finishJob(job: DedupeJob, reserve: (floor: number) => void): Promise<void> {
  if (job.stage === 'planning') { dropDedupeJob(job.sheet_id); return; }
  reserve(job.floor);
  await carryOut(job);
}

// At boot: finish every removal a restart interrupted. Call right after the
// server starts listening, before it serves a request: each sheet is marked
// busy, and its append floor reserved, synchronously.
export function resumeDuplicateRemovals(): void {
  for (const job of dedupeJobs()) {
    whenSheetFree(job.sheet_id, WHAT, reserve => finishJob(job, reserve))
      .catch(err => console.error(`Finishing the duplicate removal of sheet ${job.sheet_id} failed:`, err));
  }
}
