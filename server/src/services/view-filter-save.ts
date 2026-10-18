// The app's filter panel (client FilterBuilder): the active view's whole filter
// saved as one `where`, groups and conditions turned off included. It is
// split into the three parts the sheet keeps (lib/views/filters.ts
// splitWhere), so each column's first condition still shows in its header
// and the header menus keep editing it. Like the header saves (sheets-crud.ts)
// it is the sheet's view setting, not a setup change: no change-log entry.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { checkViewWhere, isFail, notFound } from './view-input';
import { sheetViewState, type ViewFail } from './view-store';

// raw: a `where`, or null / [] for no filter.
export function saveSheetFilters(sheetId: string, userId: string, raw: unknown): { ok: true } | ViewFail {
  if (!sheetViewState(sheetId, userId)) return notFound('Sheet');
  const filters = checkViewWhere(sheetId, userId, raw ?? null, getSheetColumns(sheetId, userId, false));
  if (isFail(filters)) return filters;
  db.prepare(`UPDATE sheets SET empty_filter = ?, column_filters = ?, row_filter = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`)
    .run(filters.empty_filter, filters.column_filters, filters.row_filter, sheetId, userId);
  return { ok: true };
}
