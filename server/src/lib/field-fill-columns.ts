// Columns still filling: from stored answers ("Add as column", MCP
// add_enrichment_field: services/answer-field-fill.ts) or a clean, formula or
// lookup column's fill (services/derived-fill.ts). Every read of the sheet shows them
// as processing until the fill is done, the grid's and the agents' alike, so
// nobody reads a half-filled column as the answer.
import { db } from './db';

export { FILL_PLACEHOLDER, overlayFilling } from './field-fill-overlay';

export function fillingColumns(sheetId: string, userId: string): string[] {
  return db.prepare(`SELECT column_name FROM enrichment_field_jobs
      WHERE sheet_id = ? AND user_id = ? AND status = 'running'
    UNION SELECT column_name FROM clean_columns
      WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
    UNION SELECT column_name FROM formula_columns
      WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
    UNION SELECT column_name FROM lookup_columns
      WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'`)
    .pluck().all(sheetId, userId, sheetId, userId, sheetId, userId, sheetId, userId) as string[];
}
