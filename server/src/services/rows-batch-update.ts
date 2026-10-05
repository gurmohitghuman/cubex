import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-helpers';
import { bumpDataVersion, checkColumns, TxnFail } from './data-plane-shared';

export interface BatchUpdate { rowId: string; cells: Record<string, string> }
export type BatchUpdateOutcome = { ok: { updated: number } } | TxnFail | { fail: 'duplicate_rows' };

export function batchUpdateRows(
  sheetId: string,
  userId: string,
  updates: BatchUpdate[],
): BatchUpdateOutcome {
  if (new Set(updates.map(u => u.rowId)).size !== updates.length) return { fail: 'duplicate_rows' };
  let fail: TxnFail | null = null;
  db.transaction(() => {
    const ids = updates.map(u => u.rowId);
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT id FROM rows WHERE sheet_id = ? AND user_id = ? AND id IN (${placeholders})`,
    ).all(sheetId, userId, ...ids) as Array<{ id: string }>;
    if (found.length !== ids.length) { fail = { fail: 'not_found' }; return; }
    const columns = new Set<string>();
    for (const update of updates) for (const col of Object.keys(update.cells)) columns.add(col);
    fail = checkColumns(sheetId, userId, columns);
    if (fail) return;
    const set = db.prepare(
      "UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    );
    for (const update of updates) {
      for (const [col, value] of Object.entries(update.cells)) set.run(jsonPath(col), value, update.rowId, userId);
    }
    bumpDataVersion(sheetId, userId);
  }).immediate();
  return fail ?? { ok: { updated: updates.length } };
}
