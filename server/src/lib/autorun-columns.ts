// Auto-run settings name columns (the status column, the columns it reads, the
// "Only run if" columns), so a column rename or delete updates them in the
// same transaction (services/column-rename.ts, column-delete.ts). Deleting the
// status column removes its auto-run; deleting a column it reads pauses it
// until a column by that name is back (services/autorun-loop.ts lifts it).
import { db } from './db';
import { autorunDropPending } from './autorun-mark';
import { renameRuleColumn } from './run-condition';

interface Row {
  id: string; status_column: string; input_columns: string; where_json: string | null; run_if: string | null;
}

const list = (raw: string | null): unknown[] => {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

const rowsOf = (sheetId: string, userId: string) => db.prepare(`SELECT id, status_column, input_columns, where_json,
  run_if FROM autorun_columns WHERE sheet_id = ? AND user_id = ?`).all(sheetId, userId) as Row[];

export function renameAutorunColumnRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  // rescan: a sweep that read the old names before the switch can't start a run.
  const update = db.prepare(`UPDATE autorun_columns SET status_column = ?, input_columns = ?, where_json = ?,
    run_if = ?, rescan = 1, updated_at = datetime('now') WHERE id = ?`);
  for (const r of rowsOf(sheetId, userId)) {
    const inputs = list(r.input_columns).map(c => (c === oldName ? newName : c));
    const renamed = (c: unknown) => !!c && typeof c === 'object' && (c as { column?: unknown }).column === oldName;
    const where = list(r.where_json).map(c => (renamed(c) ? { ...(c as object), column: newName } : c));
    update.run(r.status_column === oldName ? newName : r.status_column, JSON.stringify(inputs),
      r.where_json === null ? null : JSON.stringify(where),
      r.run_if === null ? null : renameRuleColumn(r.run_if, oldName, newName), r.id);
  }
}

// A status column's auto-run queue can hold a row per sheet row: deleting the
// column drops it in slices first (call before the delete's transaction, with
// the sheet busy), so the cascade in that transaction only takes what was
// queued meanwhile.
export async function dropAutorunQueueOf(sheetId: string, userId: string, column: string): Promise<void> {
  const id = db.prepare('SELECT id FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND status_column = ?')
    .pluck().get(sheetId, userId, column) as string | undefined;
  if (id) await autorunDropPending(sheetId, userId, id);
}

export function deleteAutorunColumnRefs(sheetId: string, userId: string, column: string): void {
  db.prepare('DELETE FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND status_column = ?')
    .run(sheetId, userId, column);
  const pause = db.prepare(`UPDATE autorun_columns SET paused_reason = 'missing_input', paused_message = ?,
    paused_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND (paused_reason IS NULL OR paused_reason <> 'user')`);
  for (const r of rowsOf(sheetId, userId)) {
    if (list(r.input_columns).includes(column)) {
      pause.run(`${column} was deleted. Auto-run waits until a column named ${column} is back.`, r.id);
    }
  }
}
