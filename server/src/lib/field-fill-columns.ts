// Columns still filling from stored answers ("+ Column", MCP
// add_enrichment_field: services/answer-field-fill.ts). Every read of the
// sheet shows them as processing until the fill is done, the grid's and the
// agents' alike, so nobody reads a half-filled column as the answer.
import { db } from './db';

export { FILL_PLACEHOLDER, overlayFilling } from './field-fill-overlay';

export function fillingColumns(sheetId: string, userId: string): string[] {
  return db.prepare(`SELECT DISTINCT column_name FROM enrichment_field_jobs
    WHERE sheet_id = ? AND user_id = ? AND status = 'running'`).pluck().all(sheetId, userId) as string[];
}
