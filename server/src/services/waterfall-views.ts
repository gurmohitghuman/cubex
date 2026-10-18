// "Hide the step columns": a waterfall's new step columns go into every view's
// hidden columns (sheet_views.hidden_columns, migration 030), the Default
// view's included, so the grid shows the result and "answered by" while each
// step's own value stays one click away (the columns picker). A view made
// later starts as a copy of another, hidden columns included. Call inside the
// start's transaction.
import { db } from '../lib/db';
import { parseHiddenColumns } from '../lib/views/refs';
import { ensuredViewRows } from './view-store';

export function hideInViews(sheetId: string, userId: string, columns: string[]): void {
  if (columns.length === 0) return;
  const views = ensuredViewRows(sheetId, userId);
  const update = db.prepare(`UPDATE sheet_views SET hidden_columns = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`);
  for (const v of views) {
    const hidden = parseHiddenColumns(v.hidden_columns);
    const next = [...new Set([...hidden, ...columns])];
    if (next.length !== hidden.length) update.run(JSON.stringify(next), v.id, userId);
  }
}
