// Column rename, delete and CSV replace inside views: every view's filters and
// hidden columns, and the sheet's row_filter (the active view's; the sheet's
// other two filters are rewritten by the callers, column-rename.ts and
// column-delete.ts). Called inside their transactions. A sheet holds at most
// MAX_VIEWS_PER_SHEET views, so this is a few small rows.
import { db } from '../lib/db';
import { dropColumn, keepOnly, mapViewColumns, renameTo, type ViewColumnFields } from '../lib/views/refs';

type ColumnMap = Parameters<typeof mapViewColumns>[1];

function rewriteViews(sheetId: string, userId: string, to: ColumnMap): void {
  const views = db.prepare(`SELECT id, empty_filter, column_filters, row_filter, hidden_columns FROM sheet_views
    WHERE sheet_id = ? AND user_id = ?`).all(sheetId, userId) as Array<ViewColumnFields & { id: string }>;
  for (const view of views) {
    const changed = mapViewColumns(view, to);
    if (!Object.keys(changed).length) continue;
    const next = { ...view, ...changed };
    db.prepare(`UPDATE sheet_views SET empty_filter = ?, column_filters = ?, row_filter = ?, hidden_columns = ?,
      updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(next.empty_filter ?? null,
      next.column_filters ?? null, next.row_filter ?? null, next.hidden_columns ?? null, view.id, userId);
  }
  const sheet = db.prepare('SELECT row_filter FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { row_filter: string | null } | undefined;
  if (!sheet?.row_filter) return;
  const changed = mapViewColumns({ empty_filter: null, column_filters: null, row_filter: sheet.row_filter }, to);
  if ('row_filter' in changed) {
    db.prepare('UPDATE sheets SET row_filter = ? WHERE id = ? AND user_id = ?')
      .run(changed.row_filter ?? null, sheetId, userId);
  }
}

export const renameViewColumnRefs = (sheetId: string, userId: string, from: string, to: string): void =>
  rewriteViews(sheetId, userId, renameTo(from, to));

export const deleteViewColumnRefs = (sheetId: string, userId: string, column: string): void =>
  rewriteViews(sheetId, userId, dropColumn(column));

// After a CSV replace (or its undo) set new columns: what views say about
// columns the sheet no longer has goes.
export function pruneViewsToColumns(sheetId: string, userId: string): void {
  const row = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { column_order: string | null } | undefined;
  let columns: string[] = [];
  try { columns = JSON.parse(row?.column_order ?? '[]'); } catch { /* none */ }
  rewriteViews(sheetId, userId, keepOnly(new Set(Array.isArray(columns) ? columns : [])));
}
