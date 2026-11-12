// Restoring a deleted column (migration 054): the app's Trash page and the Restore on its delete's toast,
// POST /api/v1/trash/restore and /:id/restore, MCP restore_from_trash.
//
// It comes back under its old name when no column has it (in any case), else "<name> (restored)", "(restored
// 2)"…; at its old place, or last when the sheet has fewer columns now; with its description and its own
// setup (trash-restore-column-setup.ts says what that does), auto-run off. Its cells go back to the rows that
// still exist, found by stable id: a row holding a value there now keeps it, and that cell stays in the item,
// as one whose row is gone (deleted since, maybe in the trash too) does; restored again, the item puts them
// into that column (into, its leftovers) once their rows are back and empty there. What other columns, views
// and settings said about it doesn't come back: the answer lists each one with how to set it up again
// (references_dropped, lib/trash/column-refs-words.ts). A column still moving into the trash (its delete
// answered before every cell was in) is refused until it is all in.
//
// It is the sheet's heavy operation while it runs (lib/sheet-busy.ts), refused while a run is active there,
// as a row restore is. The item is 'restoring' with its cursor and counts, so a restart goes on
// (resumeColumnRestores); one that had gone through no cell yet goes back to the trash as it was. The cells go
// back before the column is listed, and the last transaction lists it and writes its setup
// (trash-restore-column-finish.ts), so that holds.
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET, TRASH_RESTORE_WAIT_ROWS, TRASH_SLICE_ROWS } from '../lib/constants';
import { getSheetColumns } from '../lib/sql-helpers';
import { continueInBackground, stayBusyToFinish, whenSheetFree, withSheetBusy } from '../lib/sheet-busy';
import { runInCheckpointedRowSlices } from '../lib/slices';
import { derivedReaderCount } from '../lib/autorun-mark';
import { getTrashItem, type TrashItem } from '../lib/trash/store';
import { columnSetupOf, freeColumnName, restoreCellsSlice } from '../lib/trash/column-restore';
import type { RefSurface } from '../lib/trash/column-refs-words';
import { sheetRunBlock } from './autorun-block';
import { finishRunRewrites } from './run-config-rewrite';
import { planColumnSetup } from './trash-restore-column-setup';
import { finishColumnRestore, startFills, type FillStart, type Finished } from './trash-restore-column-finish';
import { answerOf, type ColumnRestored } from './trash-restore-column-answer';
import type { RestoreFail } from './trash-restore';

export type { ColumnRestored };

const WHAT = 'restoring a column';

// later: a multi-item restore collects the fills to start once its whole request is done (startFills).
export interface ColumnRestoreOpts { surface: RefSurface; hasSecretsScope: boolean; later?: FillStart[] }

const fail = (f: RestoreFail['fail'], message: string): RestoreFail => ({ fail: f, message });

// Its leftovers go into the column its other cells went back to, while the sheet has it.
const intoOf = (item: TrashItem, userId: string): boolean => item.restore_name !== null && item.state === 'kept'
  && getSheetColumns(item.sheet_id!, userId, false).includes(item.restore_name);

function checks(item: TrashItem, userId: string): RestoreFail | null {
  if (item.state !== 'kept') {
    return fail('conflict', item.state === 'restoring' ? 'This is already being restored.'
      : item.state === 'purging' ? 'This is being deleted.' : `"${item.column_name}" is still moving to the trash, `
        + 'try again in a moment.');
  }
  const sheet = db.prepare('SELECT name, trash_id FROM sheets WHERE id = ? AND user_id = ?').get(item.sheet_id,
    userId) as { name: string; trash_id: number | null } | undefined;
  if (!sheet) return fail('not_found', 'The sheet this column came from is gone.');
  if (sheet.trash_id !== null) {
    return fail('conflict', `Its sheet "${sheet.name}" is in the trash. Restore the sheet first.`);
  }
  if (!intoOf(item, userId) && getSheetColumns(item.sheet_id!, userId, false).length >= MAX_COLUMNS_PER_SHEET) {
    return fail('bad_request', `The sheet has ${MAX_COLUMNS_PER_SHEET} columns, the most it can hold. Delete a `
      + `column, then restore "${item.column_name}".`);
  }
  return null;
}

export async function restoreColumn(
  userId: string, itemId: number, opts: ColumnRestoreOpts,
): Promise<{ ok: ColumnRestored } | RestoreFail> {
  const item = getTrashItem(itemId, userId);
  if (!item || item.kind !== 'column') return fail('not_found', 'Nothing in the trash with that id.');
  const first = checks(item, userId);
  if (first) return first;
  const sheetId = item.sheet_id!;
  const block = sheetRunBlock(sheetId, userId,
    'Cannot restore a column while a run is active on this sheet. Stop or finish the run first.');
  if (block) return { fail: 'conflict', message: block.message, blockingRun: block.run };
  const planned = intoOf(item, userId) ? null : planColumnSetup(sheetId, userId, columnSetupOf(item),
    freeColumnName(sheetId, userId, item.column_name!), opts.hasSecretsScope);
  if (planned && 'refuse' in planned) return fail('forbidden', planned.refuse);

  const outcome = await withSheetBusy(sheetId, WHAT, async (): Promise<{ ok: ColumnRestored } | RestoreFail> => {
    await finishRunRewrites(sheetId);
    let name: string | null = null;
    let into = false;
    let problem: RestoreFail | null = null;
    db.transaction(() => {
      // Read again inside the write lock: the item, the sheet and its columns may have changed.
      const now = getTrashItem(itemId, userId);
      problem = now ? checks(now, userId) : fail('not_found', 'Nothing in the trash with that id.');
      if (problem) return;
      into = intoOf(now!, userId);
      name = into ? now!.restore_name! : freeColumnName(sheetId, userId, now!.column_name!);
      db.prepare(`UPDATE trash_items SET state = 'restoring', restore_name = ?, restore_into = ?, restore_cursor = 0,
        restored = 0, restore_skipped = 0, restore_kept = 0, restore_keys = ? WHERE id = ?`)
        .run(name, into ? 1 : 0, opts.hasSecretsScope ? 1 : 0, itemId);
    }).immediate();
    if (problem || name === null) return problem ?? fail('conflict', 'This is already being restored.');
    const got = name as string;
    const answer = (state: ColumnRestored['state'], done: Finished | null) => ({ ok: answerOf(item, got, into, state,
      done, opts.surface, planned && 'plan' in planned ? planned.plan : null) });
    if (item.row_count > TRASH_RESTORE_WAIT_ROWS) {
      continueInBackground(sheetId, WHAT, async () => { await carryOn(itemId, sheetId, userId, null); });
      return answer('restoring', null);
    }
    return answer('restored', await carryOn(itemId, sheetId, userId, opts.later ?? null));
  });
  if ('busy' in outcome && typeof outcome.busy === 'string') return { ...fail('conflict', outcome.busy), busy: true };
  return outcome as { ok: ColumnRestored } | RestoreFail;
}

// The cells, slice by slice, then the last transaction. A failure once some cells went through keeps the
// sheet busy and tries again (lib/sheet-busy.ts); one before any goes back to the trash as it was. `later`:
// where a request collects the fill to start (null: it starts once the sheet is free).
async function carryOn(itemId: number, sheetId: string, userId: string, later: FillStart[] | null):
  Promise<Finished> {
  const name = (getTrashItem(itemId, userId)!).restore_name!;
  try {
    // Each cell written queues the row for every clean, formula or lookup column reading it: fewer a slice.
    const size = Math.max(1, Math.floor(TRASH_SLICE_ROWS / (1 + derivedReaderCount(sheetId, userId, [name]))));
    await runInCheckpointedRowSlices(() => restoreCellsSlice(itemId, sheetId, userId, name, size) > 0);
    const done = db.transaction(() => finishColumnRestore(itemId, sheetId, userId, name)).immediate();
    if (done.fill) {
      if (later) later.push(done.fill);
      else startFills([done.fill]);
    }
    return done;
  } catch (error) {
    const it = getTrashItem(itemId, userId);
    if (it?.state === 'restoring' && it.restore_cursor === 0) {
      db.transaction(() => backToTrash(itemId)).immediate();
    } else {
      stayBusyToFinish(sheetId, WHAT, async () => { await carryOn(itemId, sheetId, userId, null); });
    }
    throw error;
  }
}

// A leftover's restore keeps its column's name (restore_into); a first one forgets the name it would get.
function backToTrash(itemId: number): void {
  db.prepare(`UPDATE trash_items SET state = 'kept', restore_name = CASE WHEN restore_into = 1 THEN restore_name
      ELSE NULL END, restore_into = 0, restore_cursor = 0, restored = 0, restore_skipped = 0, restore_kept = 0,
      restore_keys = 0 WHERE id = ? AND state = 'restoring'`).run(itemId);
}

// At boot (resumeTrashRestores): a column restore a restart cut short goes on; one that had gone through no
// cell yet goes back to the trash as it was.
export function resumeColumnRestores(): void {
  const items = db.prepare(`SELECT * FROM trash_items WHERE state = 'restoring' AND kind = 'column'`)
    .all() as TrashItem[];
  for (const item of items) {
    if (item.restore_cursor === 0) {
      db.transaction(() => backToTrash(item.id)).immediate();
      continue;
    }
    whenSheetFree(item.sheet_id!, WHAT, async () => { await carryOn(item.id, item.sheet_id!, item.user_id, null); })
      .catch(err => console.error(`Restoring the column of trash item ${item.id} failed:`, err));
  }
}
