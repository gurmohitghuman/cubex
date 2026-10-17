import { db } from '../lib/db';
import { parseRowData } from '../lib/sql-helpers';
import { TRANSFER_MAX_ROWS, TRANSFER_SCAN_BATCH } from '../lib/api-v1-constants';
import type { WhereItem } from '../lib/row-filter/where';
import type { CompiledFilter } from '../lib/row-filter/sql';

export type TransferSelection =
  | { all: true }
  | { row_ids: string[] }
  | { where: WhereItem[] };

// What a scan takes: a `where` compiled for the source sheet
// (services/row-filter.ts), or the rows an earlier scan of the same
// transaction found (`rowids`, in row order).
export type ScanSelection =
  | { all: true } | { row_ids: string[] } | { filter: CompiledFilter } | { rowids: number[] };

export interface SelectedRow { id: string; index: number; dataJson: string; data: Record<string, string> }

export interface ScanResult {
  matched: number; bytes: number; missingIds: string[];
  // The matched rows' rowids, while there are at most TRANSFER_MAX_ROWS: the
  // transfer's later passes read only those (a filter is checked once).
  rowids: number[];
}

type ScanRow = { rowid: number; id: string; row_index: number; data: string };

// The selected rows, TRANSFER_SCAN_BATCH at a time, to `visit`. A filter
// reads only the rows it passes (SQLite checks it); row ids and "all" walk the
// sheet in row order.
export function scanTransferRows(
  sheetId: string,
  userId: string,
  selection: ScanSelection,
  visit: (rows: SelectedRow[]) => void,
): ScanResult {
  const requested = 'row_ids' in selection ? new Set(selection.row_ids) : null;
  const filter = 'filter' in selection ? selection.filter : null;
  const foundIds = new Set<string>();
  const rowids: number[] = [];
  let matched = 0;
  let bytes = 0;
  const page = db.prepare(`
    SELECT rowid, id, row_index, data FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ?${filter ? ` AND (${filter.sql})` : ''}
    ORDER BY row_index ASC LIMIT ?
  `);
  const byRowid = db.prepare(`SELECT rowid, id, row_index, data FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? ORDER BY row_index ASC`);
  const listed = 'rowids' in selection ? selection.rowids : null;
  for (let after = -1, at = 0; ;) {
    const rows = (listed
      ? byRowid.all(JSON.stringify(listed.slice(at, at += TRANSFER_SCAN_BATCH)), sheetId, userId)
      : page.all(sheetId, userId, after, ...(filter?.params ?? []), TRANSFER_SCAN_BATCH)) as ScanRow[];
    if (!rows.length) break;
    after = rows[rows.length - 1].row_index;
    const selected: SelectedRow[] = [];
    for (const row of rows) {
      if (requested && !requested.has(row.id)) continue;
      foundIds.add(row.id);
      matched++;
      if (rowids.length <= TRANSFER_MAX_ROWS) rowids.push(row.rowid);
      bytes += Buffer.byteLength(row.data, 'utf8');
      selected.push({ id: row.id, index: row.row_index, dataJson: row.data, data: parseRowData(row.data) });
    }
    visit(selected);
  }
  return {
    matched,
    bytes,
    missingIds: requested ? [...requested].filter(id => !foundIds.has(id)) : [],
    rowids,
  };
}
