import { db } from '../lib/db';
import { parseRowData } from '../lib/sql-helpers';
import { TRANSFER_SCAN_BATCH } from '../lib/api-v1-constants';
import { rowPasses, RowCondition } from './row-selection';

export type TransferSelection =
  | { all: true }
  | { row_ids: string[] }
  | { where: RowCondition[] };

export interface SelectedRow { id: string; index: number; dataJson: string; data: Record<string, string> }

export function scanTransferRows(
  sheetId: string,
  userId: string,
  selection: TransferSelection,
  visit: (rows: SelectedRow[]) => void,
): { matched: number; bytes: number; missingIds: string[] } {
  const requested = 'row_ids' in selection ? new Set(selection.row_ids) : null;
  const foundIds = new Set<string>();
  let after = -1;
  let matched = 0;
  let bytes = 0;
  while (true) {
    const rows = db.prepare(`
      SELECT id, row_index, data FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index > ?
      ORDER BY row_index ASC LIMIT ?
    `).all(sheetId, userId, after, TRANSFER_SCAN_BATCH) as Array<{
      id: string; row_index: number; data: string;
    }>;
    if (!rows.length) break;
    after = rows[rows.length - 1].row_index;
    const selected: SelectedRow[] = [];
    for (const row of rows) {
      const data = parseRowData(row.data);
      const include = 'all' in selection || (requested?.has(row.id) ?? false)
        || ('where' in selection && rowPasses(data, selection.where));
      if (!include) continue;
      foundIds.add(row.id);
      matched++;
      bytes += Buffer.byteLength(row.data, 'utf8');
      selected.push({ id: row.id, index: row.row_index, dataJson: row.data, data });
    }
    visit(selected);
  }
  return {
    matched,
    bytes,
    missingIds: requested ? [...requested].filter(id => !foundIds.has(id)) : [],
  };
}
