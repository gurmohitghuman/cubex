import { db } from './db';
import { parseRowData } from './sql-helpers';

// Pick the rows a "Try on N rows" preview samples, split out of
// routes/ai-preview.ts (200-line guardrail): the first N rows in row_index
// order. Sort is a one-time physical reorder, so there is no view order to
// follow; the grid's column filters don't apply here (they never did).
export function samplePreviewRows(
  sheetId: string, userId: string, previewSize: number,
): Array<{ rowIndex: number; data: Record<string, string> }> {
  const rows = db.prepare(`
    SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ?
    ORDER BY row_index ASC LIMIT ?
  `).all(sheetId, userId, previewSize) as Array<{ row_index: number; data: string }>;
  return rows.map(r => ({ rowIndex: r.row_index, data: parseRowData(r.data) }));
}
