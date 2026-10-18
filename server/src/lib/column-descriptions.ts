// Column descriptions (column_descriptions, migration 035), kept by column
// name: reading them, writing one, and keeping them in step with column
// renames and deletes (services/column-rename.ts and column-delete.ts call
// these in their transactions) and with a CSV replace or an undone import.
import { randomUUID } from 'crypto';
import { db } from './db';

export function sheetColumnDescriptions(sheetId: string, userId: string): Map<string, string> {
  const rows = db.prepare('SELECT column_name, description FROM column_descriptions WHERE sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as Array<{ column_name: string; description: string }>;
  return new Map(rows.map(r => [r.column_name, r.description]));
}

// text null clears it. The caller has checked the column is the sheet's.
export function writeColumnDescription(sheetId: string, userId: string, column: string, text: string | null): void {
  if (text === null) {
    db.prepare('DELETE FROM column_descriptions WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
      .run(sheetId, userId, column);
    return;
  }
  db.prepare(`INSERT INTO column_descriptions (id, user_id, sheet_id, column_name, description) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sheet_id, column_name) DO UPDATE SET description = excluded.description, updated_at = datetime('now')`)
    .run(randomUUID(), userId, sheetId, column, text);
}

// Inside the rename's transaction. A record left under the new name (its
// column went some way that kept it) is dropped first: it isn't this column's.
export function renameColumnDescriptionRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  db.prepare('DELETE FROM column_descriptions WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .run(sheetId, userId, newName);
  db.prepare(`UPDATE column_descriptions SET column_name = ?, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?`).run(newName, sheetId, userId, oldName);
}

// Inside the delete's transaction.
export function deleteColumnDescriptionRefs(sheetId: string, userId: string, column: string): void {
  db.prepare('DELETE FROM column_descriptions WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .run(sheetId, userId, column);
}

// After a CSV replace or an undone import saved the new column list: a column
// that list doesn't hold is gone, and so is its description (kept, a column
// made later under that name would show it).
export function forgetUnlistedColumnDescriptions(sheetId: string, userId: string): void {
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  let listed: unknown = [];
  try { listed = JSON.parse(order ?? '[]'); } catch { /* none listed */ }
  db.prepare(`DELETE FROM column_descriptions WHERE sheet_id = ? AND user_id = ?
    AND column_name NOT IN (SELECT value FROM json_each(?))`)
    .run(sheetId, userId, JSON.stringify(Array.isArray(listed) ? listed : []));
}
