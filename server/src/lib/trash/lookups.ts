// Lookups in other sheets that look in a sheet in the trash (lookup_columns,
// migration 031): they stop with a message while it is there, start again
// when it is restored, and say it was deleted once it is gone for good (the
// words lookup_sheet_delete writes).
import { db } from '../db';
import { followQueued } from '../autorun-kick';

const IN_TRASH = '" it looks in is in the trash.';

export const trashedLookupMessage = (sheetName: string): string => `The sheet "${sheetName}${IN_TRASH}`;

// The lookups the trash stopped (and only those) look up again: their record,
// and an auto-run that paused on the message, whose rows then follow again.
// A fill that failed on it fills again (lookupsFillAgain).
export function restartLookupsInto(sheetIds: string[]): void {
  const ids = JSON.stringify(sheetIds);
  db.prepare(`UPDATE lookup_columns SET broken = NULL, updated_at = datetime('now')
    WHERE other_sheet_id IN (SELECT value FROM json_each(?)) AND substr(broken, -?) = ?`)
    .run(ids, IN_TRASH.length, IN_TRASH);
  const paused = db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL,
      rescan = 1, updated_at = datetime('now')
    WHERE kind = 'lookup' AND paused_reason = 'setup' AND instr(paused_message, ?) > 0
      AND EXISTS (SELECT 1 FROM lookup_columns lc WHERE lc.sheet_id = autorun_columns.sheet_id
        AND lc.column_name = autorun_columns.status_column
        AND lc.other_sheet_id IN (SELECT value FROM json_each(?)))
    RETURNING id`).pluck().all(IN_TRASH, ids) as string[];
  // Kicked once the restoring transaction has committed.
  setImmediate(() => { for (const id of paused) followQueued(id); });
}

export interface LookupRefill { id: string; sheet_id: string }

// Inside the restoring transaction (after the sheets are live and
// restartLookupsInto ran): every lookup whose fill failed because the sheet it
// looks in was in the trash, and that can read it again, fills again from the
// top, as "Look up again" would: those looking in these sheets, and those on
// them whose other sheet is live. Not one that is broken for another reason.
// Open tabs show them processing. Durable: the caller starts them after the
// request (trash-restore-sheet.ts), and a restart before that resumes them as
// it does every fill.
export function lookupsFillAgain(sheetIds: string[], userId: string): LookupRefill[] {
  const ids = JSON.stringify(sheetIds);
  const refills = db.prepare(`UPDATE lookup_columns SET fill_status = 'filling', fill_cursor = 0, filled_rows = 0,
      error_rows = 0, first_error = NULL, error_message = NULL, updated_at = datetime('now')
    WHERE user_id = ? AND fill_status = 'failed' AND broken IS NULL AND substr(error_message, -?) = ?
      AND (other_sheet_id IN (SELECT value FROM json_each(?)) OR sheet_id IN (SELECT value FROM json_each(?)))
      AND EXISTS (SELECT 1 FROM sheets s WHERE s.id = lookup_columns.other_sheet_id AND s.user_id = ?
        AND s.trash_id IS NULL)
    RETURNING id, sheet_id`).all(userId, IN_TRASH.length, IN_TRASH, ids, ids, userId) as LookupRefill[];
  db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
    WHERE id IN (SELECT value FROM json_each(?)) AND user_id = ?`)
    .run(JSON.stringify([...new Set(refills.map(r => r.sheet_id))]), userId);
  return refills;
}

// Gone for good: the message says so, and the keys of the sheet's looked-up
// columns go (their own trigger purges them in slices) before its rows do,
// so deleting the rows logs nothing.
export function lookupsLoseSheet(sheetId: string, sheetName: string): void {
  db.prepare(`UPDATE lookup_columns SET broken = ?, updated_at = datetime('now')
    WHERE other_sheet_id = ? AND (broken IS NULL OR substr(broken, -?) = ?)`)
    .run(`The sheet "${sheetName}" it looks in was deleted.`, sheetId, IN_TRASH.length, IN_TRASH);
  db.prepare('DELETE FROM lookup_sources WHERE sheet_id = ?').run(sheetId);
}
