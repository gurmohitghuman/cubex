// Auto-dedupe's key column, kept in step with the sheet's columns: a rename
// moves the setting with it (the keys stay: the values are the same), a
// delete turns it off, and so does a CSV replace or an undone import whose
// column list no longer holds it. Called inside those changes' transactions.
import { db } from '../db';
import { jsonPath } from '../json-path';
import { logSheetChange } from '../change-log';

export function renameAutoDedupeColumnRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  db.prepare(`UPDATE auto_dedupe SET column_name = ?, path = ?, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?`).run(newName, jsonPath(newName), sheetId, userId, oldName);
}

export function deleteAutoDedupeColumnRefs(sheetId: string, userId: string, column: string): void {
  const gone = db.prepare('DELETE FROM auto_dedupe WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .run(sheetId, userId, column).changes;
  if (gone > 0) {
    logSheetChange(sheetId, userId, 'auto_dedupe', `Turned off auto-dedupe: its column "${column}" was deleted`,
      { column });
  }
}

export function forgetUnlistedAutoDedupe(sheetId: string, userId: string): void {
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  let listed: unknown = [];
  try { listed = JSON.parse(order ?? '[]'); } catch { /* none listed */ }
  const column = db.prepare(`SELECT column_name FROM auto_dedupe WHERE sheet_id = ? AND user_id = ?
    AND column_name NOT IN (SELECT value FROM json_each(?))`).pluck()
    .get(sheetId, userId, JSON.stringify(Array.isArray(listed) ? listed : [])) as string | undefined;
  if (column !== undefined) {
    db.prepare('DELETE FROM auto_dedupe WHERE sheet_id = ? AND user_id = ?').run(sheetId, userId);
    logSheetChange(sheetId, userId, 'auto_dedupe', `Turned off auto-dedupe: the sheet no longer has "${column}"`,
      { column });
  }
}
