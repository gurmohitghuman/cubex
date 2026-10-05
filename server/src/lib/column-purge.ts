import { db } from './db';
import { jsonPath } from './sql-rows';
import { eachRowIdSlice, sheetRowIds } from './row-order';
import { whenSheetFree } from './sheet-busy';

// Copying or removing a key across every row of a big sheet is a heavy job, so
// it runs in slices between requests (lib/slices.ts). A removal is recorded in
// column_purges while it runs (migration 003): a restart finishes it
// (resumeColumnPurges), and lib/column-repair.ts skips the key meanwhile instead
// of mistaking the leftovers for a column that should be listed.

// Every row holding `from` also gets its value under `to` (the first half of a
// rename: the sheet still shows `from`, untouched). Rows go in storage order
// (lib/row-order.ts), like the strip below. The caller must switch the name in
// the same tick this resolves (services/column-rename.ts does).
export async function copyColumnKey(sheetId: string, userId: string, from: string, to: string): Promise<void> {
  const copy = db.prepare(`
    UPDATE rows SET data = json_set(data, ?, json_extract(data, ?))
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? AND json_type(data, ?) IS NOT NULL
  `);
  const [toPath, fromPath] = [jsonPath(to), jsonPath(from)];
  const rowIds = await sheetRowIds(sheetId, userId);
  await eachRowIdSlice(rowIds, ids => {
    copy.run(toPath, fromPath, ids, sheetId, userId, fromPath);
  });
  // Rows appended meanwhile (webhook deliveries) have rowids past every one
  // collected. Copy those last, synchronously: the caller switches the name in
  // the same tick, so no request can slip a row in between.
  db.prepare(`
    UPDATE rows SET data = json_set(data, ?, json_extract(data, ?))
    WHERE rowid > ? AND +sheet_id = ? AND +user_id = ? AND json_type(data, ?) IS NOT NULL
  `).run(toPath, fromPath, rowIds.length > 0 ? rowIds[rowIds.length - 1] : 0, sheetId, userId, fromPath);
}

export function recordPurge(sheetId: string, userId: string, name: string): void {
  db.prepare('INSERT OR IGNORE INTO column_purges (sheet_id, user_id, column_name) VALUES (?, ?, ?)')
    .run(sheetId, userId, name);
}

export function forgetPurge(sheetId: string, name: string): void {
  db.prepare('DELETE FROM column_purges WHERE sheet_id = ? AND column_name = ?').run(sheetId, name);
}

export function pendingPurges(sheetId: string): Set<string> {
  return new Set(db.prepare('SELECT column_name FROM column_purges WHERE sheet_id = ?').pluck().all(sheetId) as string[]);
}

// Removes the key from every row, then forgets the record. Call recordPurge
// first, in the same transaction that stops the sheet listing the column.
export async function purgeColumnKey(sheetId: string, userId: string, name: string): Promise<void> {
  const strip = db.prepare(`
    UPDATE rows SET data = json_remove(data, ?)
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? AND json_type(data, ?) IS NOT NULL
  `);
  const path = jsonPath(name);
  await eachRowIdSlice(await sheetRowIds(sheetId, userId), ids => { strip.run(path, ids, sheetId, userId, path); });
  forgetPurge(sheetId, name);
}

// At boot: finish whatever a restart interrupted. Call right after the server
// starts listening, before it serves a request: every affected sheet is marked
// busy synchronously, so nothing (a new column with the pending name, say) can
// race a strip that hasn't reached its sheet yet.
export function resumeColumnPurges(): void {
  const pending = db.prepare('SELECT sheet_id, user_id, column_name FROM column_purges').all() as
    Array<{ sheet_id: string; user_id: string; column_name: string }>;
  const bySheet = new Map<string, typeof pending>();
  for (const p of pending) bySheet.set(p.sheet_id, [...(bySheet.get(p.sheet_id) ?? []), p]);
  for (const [sheetId, purges] of bySheet) {
    whenSheetFree(sheetId, 'finishing a column change', async () => {
      for (const p of purges) await purgeColumnKey(sheetId, p.user_id, p.column_name);
    }).catch(err => console.error(`Finishing the column change on sheet ${sheetId} failed:`, err));
  }
}
