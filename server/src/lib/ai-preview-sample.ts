import { db } from './db';
import { parseRowData } from './sql-helpers';
import type { CheckedRule } from './run-condition';
import { rowsByIndex, scanRule } from '../services/run-condition-rows';

// Pick the rows a "Try on N rows" preview samples, split out of
// routes/ai-preview.ts (200-line guardrail): the first N rows in row_index
// order. Sort is a one-time physical reorder, so there is no view order to
// follow; the grid's column filters don't apply here (they never did). With
// an "Only run if" rule, the first N rows that pass it, and the run's row
// count is the rows that pass.
export async function samplePreviewRows(
  sheetId: string, userId: string, previewSize: number, rule: CheckedRule | null,
): Promise<{ rows: Array<{ rowIndex: number; data: Record<string, string> }>; runTargetRows: number }> {
  if (rule) {
    const scan = await scanRule({ sheetId, userId, tree: rule.tree, columns: rule.columns, keepPassing: previewSize });
    return { rows: rowsByIndex(sheetId, userId, scan.passingRows), runTargetRows: scan.passing };
  }
  // EXACT count of rows "Run All Rows" will process, UNFILTERED, matching
  // ai-run-start.ts. The client's sheetData.totalRows is filter-aware (it shrinks
  // when the empty-filter is on), so a cost estimate built from it would UNDERSTATE
  // the run. Send the real target count so the estimate can't show less than billed.
  const runTargetRows = (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?')
    .get(sheetId, userId) as { c: number }).c;
  const rows = db.prepare(`
    SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ?
    ORDER BY row_index ASC LIMIT ?
  `).all(sheetId, userId, previewSize) as Array<{ row_index: number; data: string }>;
  return { rows: rows.map(r => ({ rowIndex: r.row_index, data: parseRowData(r.data) })), runTargetRows };
}
