import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-helpers';
import { bumpDataVersion, checkColumns, TxnFail } from './data-plane-shared';
import { markAutorunEdits } from '../lib/autorun-mark';
import { settleEdits } from './auto-dedupe-settle';
import { autoDedupeAnswer, type AutoDedupeAnswer } from './auto-dedupe-answer';
import type { Surface } from './trash-answer';

export interface BatchUpdate { rowId: string; cells: Record<string, string> }
// auto_dedupe: rows auto-dedupe sent to the trash (another row has their new key).
export type BatchUpdateOutcome =
  | { ok: { updated: number; auto_dedupe?: AutoDedupeAnswer } } | TxnFail | { fail: 'duplicate_rows' };

export function batchUpdateRows(
  sheetId: string,
  userId: string,
  updates: BatchUpdate[],
  surface: Surface,
): BatchUpdateOutcome {
  if (new Set(updates.map(u => u.rowId)).size !== updates.length) return { fail: 'duplicate_rows' };
  let fail: TxnFail | null = null;
  let auto: AutoDedupeAnswer | undefined;
  db.transaction(() => {
    const ids = updates.map(u => u.rowId);
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT rowid AS rid, id FROM rows WHERE sheet_id = ? AND user_id = ? AND id IN (${placeholders})`,
    ).all(sheetId, userId, ...ids) as Array<{ rid: number; id: string }>;
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
    markAutorunEdits(sheetId, userId,
      updates.flatMap(u => Object.keys(u.cells).map(column => ({ column, rowId: u.rowId }))));
    bumpDataVersion(sheetId, userId);
    const ridOf = new Map(found.map(r => [r.id, r.rid]));
    const deduped = settleEdits(sheetId, userId,
      updates.map(u => ({ rid: ridOf.get(u.rowId)!, columns: Object.keys(u.cells) })));
    auto = autoDedupeAnswer(userId, deduped, new Set(ids), surface);
  }).immediate();
  return fail ?? { ok: { updated: updates.length, ...(auto ? { auto_dedupe: auto } : {}) } };
}
