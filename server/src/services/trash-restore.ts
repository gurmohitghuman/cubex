// Restoring a batch of deleted rows (lib/trash/restore-rows.ts says where they
// go and how their cells come back): the app's Trash page and its "Restore" on
// a delete's toast, POST /api/v1/trash/:id/restore and MCP restore_from_trash.
// The whole batch, or rows picked from it (a few found by a search).
//
// It is the sheet's heavy operation while it runs (lib/sheet-busy.ts), refused
// while a run is active there, as a delete is. The item is 'restoring' with how
// many rows are back, so a restart goes on (resumeTrashRestores); one that had
// put none back yet goes back to the trash as it was. Auto-run leaves restored
// rows alone (they come back as they were), and open tabs reload once they're in.
import { db } from '../lib/db';
import {
  MAX_COLUMNS_PER_SHEET, MAX_ROWS_PER_SHEET, TRASH_RESTORE_PICK_MAX, TRASH_RESTORE_WAIT_ROWS, TRASH_SLICE_ROWS,
} from '../lib/constants';
import { countRows, touchSheet } from '../lib/sql-helpers';
import { continueInBackground, nextRowIndex, stayBusyToFinish, whenSheetFree, withSheetBusy } from '../lib/sheet-busy';
import { runInCheckpointedSlices } from '../lib/slices';
import { autorunRowsRemoved, autorunSkipRestore } from '../lib/autorun-mark';
import { getTrashItem, type TrashItem } from '../lib/trash/store';
import {
  missingColumns, oldPlacesFree, planColumns, restoreSlice, type ColumnPlan,
} from '../lib/trash/restore-rows';
import { countOf, logSheetChange } from '../lib/change-log';
import { sheetRunBlock, type BlockingRun } from './autorun-block';

const WHAT = 'restoring rows';

export interface RestoreFail {
  fail: 'not_found' | 'conflict' | 'bad_request'; message: string; busy?: boolean; blockingRun?: BlockingRun;
}
export interface RowsRestored {
  trash_id: number; sheet_id: string; state: 'restored' | 'restoring'; rows: number;
  place: 'old' | 'end'; columns_added: string[]; columns_left_out: string[];
}

export async function restoreRows(
  userId: string, itemId: number, picks: number[] | null = null,
): Promise<{ ok: RowsRestored } | RestoreFail> {
  const item = getTrashItem(itemId, userId);
  if (!item || item.kind !== 'rows') return { fail: 'not_found', message: 'Nothing in the trash with that id.' };
  const stateFail = stateProblem(item);
  if (stateFail) return stateFail;
  const sheetId = item.sheet_id!;
  const sheet = db.prepare('SELECT name, trash_id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId) as
    { name: string; trash_id: number | null } | undefined;
  if (!sheet) return { fail: 'not_found', message: 'The sheet these rows came from is gone.' };
  if (sheet.trash_id !== null) {
    return { fail: 'conflict', message: `Their sheet "${sheet.name}" is in the trash. Restore the sheet first.` };
  }
  if (picks) {
    if (picks.length === 0 || picks.length > TRASH_RESTORE_PICK_MAX || picks.some(p => !Number.isInteger(p))) {
      return { fail: 'bad_request', message: `Pick 1 to ${TRASH_RESTORE_PICK_MAX} rows of the batch (their seq).` };
    }
    picks = [...new Set(picks)];
  }
  const count = picks ? db.prepare(`SELECT COUNT(*) FROM trash_rows WHERE item_id = ?
    AND seq IN (SELECT value FROM json_each(?))`).pluck().get(itemId, JSON.stringify(picks)) as number : item.row_count;
  if (count === 0) return { fail: 'bad_request', message: 'None of those rows is in this batch.' };
  if (countRows(sheetId, userId) + count > MAX_ROWS_PER_SHEET) {
    return { fail: 'bad_request', message: `Restoring ${countOf(count, 'row')} would pass the sheet's limit of `
      + `${MAX_ROWS_PER_SHEET.toLocaleString('en-US')} rows. Delete some rows first.` };
  }
  // Cells are never left out: no room for the columns the rows need, no restore.
  const cols = missingColumns(sheetId, userId, item);
  if (cols.missing.length > cols.room) {
    const named = `${cols.missing.slice(0, 5).join(', ')}${cols.missing.length > 5 ? ', …' : ''}`;
    return { fail: 'bad_request', message: `These rows need ${countOf(cols.missing.length, 'column')} the sheet `
      + `doesn't have (${named}), and it has room for ${cols.room} more (${MAX_COLUMNS_PER_SHEET} at most). `
      + 'Delete some columns, or download the rows as CSV.' };
  }
  const block = sheetRunBlock(sheetId, userId,
    'Cannot restore rows while a run is active on this sheet. Stop or finish the run first.');
  if (block) return { fail: 'conflict', message: block.message, blockingRun: block.run };

  const outcome = await withSheetBusy(sheetId, WHAT, async (reserve): Promise<{ ok: RowsRestored } | RestoreFail> => {
    const old = await oldPlacesFree(item, sheetId, userId, picks);
    let plan: ColumnPlan | null = null;
    let through = 0;
    let rows = count;
    db.transaction(() => {
      // Read again: auto-dedupe may have added a row to the batch meanwhile.
      const now = getTrashItem(itemId, userId);
      if (now?.state !== 'kept') return;
      if (!picks) rows = now.row_count;
      const start = old ? null : nextRowIndex(sheetId, userId);
      through = start === null ? topOf(now, picks) : start + rows - 1;
      db.prepare("UPDATE trash_items SET state = 'restoring', restore_at = ?, restored = 0 WHERE id = ?")
        .run(start, itemId);
      plan = planColumns(sheetId, userId, item);
    })();
    if (!plan) return { fail: 'conflict', message: 'This batch is already being restored or deleted for good.' };
    const columns = plan as ColumnPlan;
    reserve(through + 1);
    const answer = (state: RowsRestored['state']): { ok: RowsRestored } => ({ ok: {
      trash_id: itemId, sheet_id: sheetId, state, rows, place: old ? 'old' : 'end',
      columns_added: columns.added, columns_left_out: columns.dropped,
    } });
    try {
      await autorunSkipRestore(sheetId, userId, through);
      if (picks) {
        // Picked rows: one transaction, the batch back to 'kept' with it.
        const p = picks;
        db.transaction(() => {
          restoreSlice(itemId, sheetId, userId, columns, TRASH_RESTORE_PICK_MAX, p);
          finishRestore(itemId, sheetId, userId);
        })();
        return answer('restored');
      }
    } catch (error) {
      // No row is back yet: the batch goes back to the trash as it was.
      db.transaction(() => backToTrash(itemId, sheetId, userId))();
      throw error;
    }
    const rest = () => carryOn(itemId, sheetId, userId, columns);
    if (rows > TRASH_RESTORE_WAIT_ROWS) {
      continueInBackground(sheetId, WHAT, rest);
      return answer('restoring');
    }
    await rest();
    return answer('restored');
  });
  if ('busy' in outcome && typeof outcome.busy === 'string') {
    return { fail: 'conflict', message: outcome.busy, busy: true };
  }
  return outcome as { ok: RowsRestored } | RestoreFail;
}

function stateProblem(item: TrashItem): RestoreFail | null {
  if (item.state === 'kept') return null;
  const message = item.state === 'restoring' ? 'This is already being restored.'
    : item.state === 'purging' ? 'This is being deleted for good.'
    : 'These rows are still being deleted. Try again in a moment.';
  return { fail: 'conflict', message };
}

// The highest old place among the rows going back.
function topOf(item: TrashItem, picks: number[] | null): number {
  if (!picks) return item.top_index ?? 0;
  return db.prepare(`SELECT MAX(row_index) FROM trash_rows WHERE item_id = ?
    AND seq IN (SELECT value FROM json_each(?))`).pluck().get(item.id, JSON.stringify(picks)) as number;
}

// The rest of a whole batch, slice by slice; a failure keeps the sheet busy
// and tries again (lib/sheet-busy.ts), so the rows never stay half back.
async function carryOn(itemId: number, sheetId: string, userId: string, plan: ColumnPlan): Promise<void> {
  try {
    await runInCheckpointedSlices(() =>
      restoreSlice(itemId, sheetId, userId, plan, TRASH_SLICE_ROWS, null) > 0);
    db.transaction(() => finishRestore(itemId, sheetId, userId))();
  } catch (error) {
    stayBusyToFinish(sheetId, WHAT, () => carryOn(itemId, sheetId, userId, plan));
    throw error;
  }
}

// The rows are back: open tabs reload, the change log says so, and the batch
// leaves the trash (or, rows picked from it, stays with the rest).
function finishRestore(itemId: number, sheetId: string, userId: string): void {
  const it = db.prepare('SELECT row_count, restored, restore_at FROM trash_items WHERE id = ?').get(itemId) as
    { row_count: number; restored: number; restore_at: number | null };
  db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(sheetId, userId);
  touchSheet(sheetId, userId);
  const where = it.restore_at === null ? 'to their old places' : 'to the end of the sheet';
  logSheetChange(sheetId, userId, 'rows_restored', `Restored ${countOf(it.restored, 'row')} ${where}`,
    { detail: { rows: it.restored, trash_id: itemId, place: it.restore_at === null ? 'old' : 'end' } });
  if (it.row_count <= 0) db.prepare('DELETE FROM trash_items WHERE id = ?').run(itemId);
  else db.prepare("UPDATE trash_items SET state = 'kept', restore_at = NULL, restored = 0 WHERE id = ?").run(itemId);
  // Auto-run's fence went to the top place reserved; past the last row it
  // would pass over rows appended next (a picked row of the batch deleted again).
  autorunRowsRemoved(sheetId, userId);
}

// A restore that put no row back: the batch is kept again, and auto-run's
// fence drops back to the last row there.
function backToTrash(itemId: number, sheetId: string, userId: string): void {
  db.prepare("UPDATE trash_items SET state = 'kept', restore_at = NULL, restored = 0 WHERE id = ?").run(itemId);
  autorunRowsRemoved(sheetId, userId);
}

// At boot: a restore a restart cut short goes on; one that had put no row back
// yet goes back to the trash as it was (the fence follows the rows there).
export function resumeTrashRestores(): void {
  const items = db.prepare(`SELECT * FROM trash_items WHERE state = 'restoring' AND kind = 'rows'`)
    .all() as TrashItem[];
  for (const item of items) {
    const sheetId = item.sheet_id!;
    if (item.restored === 0) {
      db.transaction(() => backToTrash(item.id, sheetId, item.user_id))();
      continue;
    }
    whenSheetFree(sheetId, WHAT, async reserve => {
      const plan = db.transaction(() => planColumns(sheetId, item.user_id, item))();
      reserve(item.restore_at === null ? (item.top_index ?? 0) + 1 : item.restore_at + item.restored + item.row_count);
      await carryOn(item.id, sheetId, item.user_id, plan);
    }).catch(err => console.error(`Restoring trash batch ${item.id} failed:`, err));
  }
}
