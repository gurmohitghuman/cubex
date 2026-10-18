// Lookups in other sheets that look in a sheet in the trash (lookup_columns,
// migration 031): they stop with a message while it is there, start again
// when it is restored, and say it was deleted once it is gone for good (the
// words lookup_sheet_delete writes).
import { db } from '../db';
import { followQueued } from '../autorun-kick';
import type { LookupColumnRow } from '../lookup-columns';

const IN_TRASH = '" it looks in is in the trash.';

export const trashedLookupMessage = (sheetName: string): string => `The sheet "${sheetName}${IN_TRASH}`;

// The lookups the trash stopped (and only those) look up again: their record,
// and an auto-run that paused on the message, whose rows then follow again.
// A fill that failed on it is the caller's to start again (trash-restore-sheet.ts).
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

// Lookups into these sheets whose fill failed because the sheet was in the trash.
export function lookupsFailedOnTrash(sheetIds: string[], userId: string): LookupColumnRow[] {
  return db.prepare(`SELECT * FROM lookup_columns WHERE other_sheet_id IN (SELECT value FROM json_each(?))
    AND user_id = ? AND fill_status = 'failed' AND instr(error_message, ?) > 0`)
    .all(JSON.stringify(sheetIds), userId, IN_TRASH) as LookupColumnRow[];
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
