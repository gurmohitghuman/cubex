import { db } from './db';
import { COLUMN_TRASH_SLICE_ROWS } from './constants';
import { jsonPath } from './sql-rows';
import { eachRowIdSlice, sheetRowIds } from './row-order';
import { stayBusyToFinish, whenSheetFree } from './sheet-busy';
import { runInputPath } from './run-inputs/stale-sql';
import { copyCellsToItem, purgeTrashItem, sealColumnItem } from './trash/column-move';

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
    UPDATE rows SET data = json_set(data, ?, json_extract(data, ?)), updated_at = datetime('now')
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?
      AND json_type(data, ?) IS NOT NULL
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
    UPDATE rows SET data = json_set(data, ?, json_extract(data, ?)), updated_at = datetime('now')
    WHERE rowid > ? AND +sheet_id = ? AND +user_id = ? AND json_type(data, ?) IS NOT NULL
  `).run(toPath, fromPath, rowIds.length > 0 ? rowIds[rowIds.length - 1] : 0, sheetId, userId, fromPath);
}

// trashId: a column delete whose cells go to that trash item (lib/trash/column-move.ts) as they are stripped.
export function recordPurge(sheetId: string, userId: string, name: string, trashId: number | null = null): void {
  db.prepare('INSERT OR IGNORE INTO column_purges (sheet_id, user_id, column_name, trash_id) VALUES (?, ?, ?, ?)')
    .run(sheetId, userId, name, trashId);
}

export function forgetPurge(sheetId: string, name: string): void {
  db.prepare('DELETE FROM column_purges WHERE sheet_id = ? AND column_name = ?').run(sheetId, name);
}

export function pendingPurges(sheetId: string): Set<string> {
  return new Set(db.prepare('SELECT column_name FROM column_purges WHERE sheet_id = ?').pluck()
    .all(sheetId) as string[]);
}

// Removes the key from every row, then forgets the record. Call recordPurge
// first, in the same transaction that stops the sheet listing the column. The
// same pass drops deleted run columns' keys from run_inputs (run_input_purges,
// lib/run-inputs/keys.ts), in the same row write. When the record names a
// trash item still filling (a column deleted to the trash), each slice first
// copies its rows' cells into it, in the same transaction, and the last one
// seals it.
export async function purgeColumnKey(sheetId: string, userId: string, name: string): Promise<void> {
  const dead = db.prepare('SELECT key FROM run_input_purges WHERE sheet_id = ?').pluck().all(sheetId) as number[];
  const strip = dead.length === 0 ? db.prepare(`
    UPDATE rows SET data = json_remove(data, ?), updated_at = datetime('now')
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?
      AND json_type(data, ?) IS NOT NULL
  `) : db.prepare(`
    UPDATE rows SET data = json_remove(data, ?),
      run_inputs = json_remove(run_inputs, ${dead.map(() => '?').join(', ')}),
      updated_at = CASE WHEN json_type(data, ?) IS NOT NULL THEN datetime('now') ELSE updated_at END
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?
      AND (json_type(data, ?) IS NOT NULL OR (${dead.map(() => 'json_type(run_inputs, ?) IS NOT NULL').join(' OR ')}))
  `);
  // Only rows holding the cell or a dead key are written.
  const path = jsonPath(name);
  const keys = dead.map(runInputPath);
  const item = purgeTrashItem(sheetId, name);
  const stripSlice = (ids: string) => {
    if (dead.length === 0) strip.run(path, ids, sheetId, userId, path);
    else strip.run(path, ...keys, path, ids, sheetId, userId, path, ...keys);
  };
  const rowIds = await sheetRowIds(sheetId, userId);
  if (item === null) await eachRowIdSlice(rowIds, stripSlice);
  else {
    // The cells are written twice (into the trash, out of the rows): smaller slices, each checkpointed.
    await eachRowIdSlice(rowIds, ids => {
      db.transaction(() => {
        copyCellsToItem(item, sheetId, userId, name, path, ids);
        stripSlice(ids);
      }).immediate();
    }, { rows: COLUMN_TRASH_SLICE_ROWS, checkpointed: true });
  }
  if (item === null) forgetPurge(sheetId, name);
  else {
    db.transaction(() => {
      sealColumnItem(item);
      forgetPurge(sheetId, name);
    }).immediate();
  }
  if (dead.length > 0) {
    db.prepare('DELETE FROM run_input_purges WHERE sheet_id = ? AND key IN (SELECT value FROM json_each(?))')
      .run(sheetId, JSON.stringify(dead));
  }
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
    const finish = async () => {
      // Read again: another job may have finished a strip while this waited,
      // and a name no longer recorded may be a real column again.
      const still = pendingPurges(sheetId);
      for (const p of purges) {
        if (still.has(p.column_name)) await purgeColumnKey(sheetId, p.user_id, p.column_name);
      }
    };
    whenSheetFree(sheetId, 'finishing a column change', async () => {
      try { await finish(); } catch (err) {
        console.error(`Finishing the column change on sheet ${sheetId} failed, retrying:`, err);
        stayBusyToFinish(sheetId, 'finishing a column change', finish);
      }
    }).catch(err => console.error(`Finishing the column change on sheet ${sheetId} failed:`, err));
  }
}
