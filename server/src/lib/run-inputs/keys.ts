// Run columns' keys in rows.run_inputs (run_input_keys, migration 039), kept by
// the main column's name and in step with column renames and deletes
// (services/column-rename.ts and column-delete.ts call these in their
// transactions), a CSV replace and an undone import, as column descriptions are.
import { db } from '../db';

// The column's key, or null while no run has fingerprinted a row of it.
export function runInputKey(sheetId: string, userId: string, column: string): number | null {
  return (db.prepare('SELECT id FROM run_input_keys WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .pluck().get(sheetId, userId, column) as number | undefined) ?? null;
}

// Every key of the sheet's columns, by column name.
export function sheetRunInputKeys(sheetId: string, userId: string): Map<string, number> {
  const rows = db.prepare('SELECT column_name, id FROM run_input_keys WHERE sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as Array<{ column_name: string; id: number }>;
  return new Map(rows.map(r => [r.column_name, r.id]));
}

// The column's key, made the first time a run writes a fingerprint (a run's
// worker thread, or the API thread promoting a preview).
export function ensureRunInputKey(sheetId: string, userId: string, column: string): number {
  db.prepare('INSERT OR IGNORE INTO run_input_keys (user_id, sheet_id, column_name) VALUES (?, ?, ?)')
    .run(userId, sheetId, column);
  return runInputKey(sheetId, userId, column)!;
}

// A key that goes is kept in run_input_purges until the column purge that
// follows its delete (or rename) has stripped it from every row (lib/column-purge.ts).
function dropKeys(sheetId: string, userId: string, where: string, arg: string): void {
  db.prepare(`INSERT OR IGNORE INTO run_input_purges (sheet_id, key)
    SELECT sheet_id, id FROM run_input_keys WHERE sheet_id = ? AND user_id = ? AND ${where}`)
    .run(sheetId, userId, arg);
  db.prepare(`DELETE FROM run_input_keys WHERE sheet_id = ? AND user_id = ? AND ${where}`).run(sheetId, userId, arg);
}

// Inside the rename's transaction. A key left under the new name isn't this
// column's: it goes first, and its fingerprints with it (never read again).
export function renameRunInputKey(sheetId: string, userId: string, oldName: string, newName: string): void {
  dropKeys(sheetId, userId, 'column_name = ?', newName);
  db.prepare('UPDATE run_input_keys SET column_name = ? WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .run(newName, sheetId, userId, oldName);
}

// Inside the delete's transaction. A key is never reused, so nothing reads the
// rows' fingerprints under it again; the column's purge strips them.
export function deleteRunInputKey(sheetId: string, userId: string, column: string): void {
  dropKeys(sheetId, userId, 'column_name = ?', column);
}

// After a CSV replace or an undone import saved the new column list: the key of
// a column that list doesn't hold goes (a column made later under its name starts afresh).
export function forgetUnlistedRunInputKeys(sheetId: string, userId: string): void {
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  let listed: unknown = [];
  try { listed = JSON.parse(order ?? '[]'); } catch { /* none listed */ }
  dropKeys(sheetId, userId, 'column_name NOT IN (SELECT value FROM json_each(?))',
    JSON.stringify(Array.isArray(listed) ? listed : []));
}
