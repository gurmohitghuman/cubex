// Undo journals' columns (migration 041) in step with the sheet's: a rename
// moves the name in each journal's slot list (one record per run, never its
// rows), a deleted column's slot reads null, so a column made later under its
// name is never written by an undo. Called in the rename's and the delete's
// transactions (services/column-rename.ts, column-delete.ts), and after a CSV
// replace or an undone import saved the new column list, as run_inputs keys are.
import { db } from '../db';

// Each journal of the sheet that can still be undone, its slots rewritten by
// `slot` (an SQL expression over json_each's value), where `has` finds one.
function rewriteSlots(sheetId: string, userId: string, slot: string, slotArgs: unknown[], has: string,
  hasArgs: unknown[]): void {
  db.prepare(`UPDATE run_undos SET columns = (SELECT json_group_array(${slot} ORDER BY key)
      FROM json_each(run_undos.columns))
    WHERE sheet_id = ? AND user_id = ? AND state IN ('kept', 'undoing')
      AND EXISTS (SELECT 1 FROM json_each(run_undos.columns) WHERE ${has})`)
    .run(...slotArgs, sheetId, userId, ...hasArgs);
}

// A slot left under the new name isn't this column's (its column went
// without a delete reaching it): it goes first.
export function renameUndoColumn(sheetId: string, userId: string, oldName: string, newName: string): void {
  deleteUndoColumn(sheetId, userId, newName);
  const slot = 'CASE WHEN value = ? THEN ? ELSE value END';
  rewriteSlots(sheetId, userId, slot, [oldName, newName], 'value = ?', [oldName]);
}

export function deleteUndoColumn(sheetId: string, userId: string, column: string): void {
  rewriteSlots(sheetId, userId, 'CASE WHEN value = ? THEN NULL ELSE value END', [column], 'value = ?', [column]);
}

// After a CSV replace or an undone import saved the new column list: a slot
// whose column that list doesn't hold reads null.
export function forgetUnlistedUndoColumns(sheetId: string, userId: string): void {
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  let listed: unknown = [];
  try { listed = JSON.parse(order ?? '[]'); } catch { /* none listed */ }
  const names = JSON.stringify(Array.isArray(listed) ? listed : []);
  const unlisted = 'value IS NOT NULL AND value NOT IN (SELECT value FROM json_each(?))';
  rewriteSlots(sheetId, userId, `CASE WHEN ${unlisted} THEN NULL ELSE value END`, [names], unlisted, [names]);
}
