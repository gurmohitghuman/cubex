// The app's filter panel (client FilterBuilder): the active view's whole filter
// saved as one `where`, groups and conditions turned off included. It is
// split into the three parts the sheet keeps (lib/views/filters.ts
// splitWhere), so each column's first condition still shows in its header
// and the header menus keep editing it. Like the header saves (sheets-crud.ts)
// it is the sheet's view setting, not a setup change: no change-log entry.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { viewWhere } from '../lib/views/filters';
import { checkViewWhere, isFail, notFound } from './view-input';
import { sheetViewState, type ViewFail } from './view-store';

// raw: a `where`, or null / [] for no filter.
// The panel sends the whole filter on every change, so a rule saved before is
// checked against the saved one (a run-state rule on a column that lost its
// run since must not block every other change; view-input.ts checkViewWhere).
export function saveSheetFilters(sheetId: string, userId: string, raw: unknown): { ok: true } | ViewFail {
  const state = sheetViewState(sheetId, userId);
  if (!state) return notFound('Sheet');
  const filters = checkViewWhere(sheetId, userId, raw ?? null, getSheetColumns(sheetId, userId, false),
    viewWhere(state));
  if (isFail(filters)) return filters;
  db.prepare(`UPDATE sheets SET empty_filter = ?, column_filters = ?, row_filter = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`)
    .run(filters.empty_filter, filters.column_filters, filters.row_filter, sheetId, userId);
  return { ok: true };
}
