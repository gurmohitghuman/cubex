// Describing a sheet or one of its columns: one implementation for the app,
// REST and MCP. A description is a person's (or an agent's) words about what
// the sheet or column holds; get_sheet returns them and the app shows them. It
// is never sent to an AI run. Empty text or null clears it. Every write bumps
// data_version, so every open grid (other windows, the app after an agent's
// write) picks it up.
import { db } from '../lib/db';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { cleanDescription } from '../lib/description-text';
import { writeColumnDescription } from '../lib/column-descriptions';
import { MAX_COLUMN_DESCRIPTION_CHARS, MAX_SHEET_DESCRIPTION_CHARS } from '../lib/constants-columns';
import { bumpDataVersion } from './data-plane-shared';
import { logSheetChange } from '../lib/change-log';

export type DescribeOutcome =
  | { ok: { description: string | null } }
  | { fail: 'not_found' | 'bad_request'; message: string };

// What's wrong with a description before anything else in the call is done
// (a rename or a new column that comes with one), or null.
export function descriptionProblem(raw: unknown, of: 'column' | 'sheet'): string | null {
  const cleaned = cleanDescription(raw, of === 'column' ? MAX_COLUMN_DESCRIPTION_CHARS : MAX_SHEET_DESCRIPTION_CHARS);
  return 'error' in cleaned ? cleaned.error : null;
}

export function describeColumn(sheetId: string, userId: string, column: string, raw: unknown): DescribeOutcome {
  const cleaned = cleanDescription(raw, MAX_COLUMN_DESCRIPTION_CHARS);
  if ('error' in cleaned) return { fail: 'bad_request', message: cleaned.error };
  let outcome: DescribeOutcome = { ok: { description: cleaned.text } };
  // Checked and written together, so a rename or delete can't come between.
  db.transaction(() => {
    if (!verifySheetOwnership(sheetId, userId)) { outcome = { fail: 'not_found', message: 'Sheet not found' }; return; }
    if (!getSheetColumns(sheetId, userId, false).includes(column)) {
      outcome = { fail: 'not_found', message: `Column "${column}" not found in this sheet` };
      return;
    }
    writeColumnDescription(sheetId, userId, column, cleaned.text);
    bumpDataVersion(sheetId, userId);
    logSheetChange(sheetId, userId, 'description',
      cleaned.text ? `Described the column "${column}"` : `Removed the description of "${column}"`,
      { column, detail: { description: cleaned.text } });
  }).immediate();
  return outcome;
}

export function describeSheet(sheetId: string, userId: string, raw: unknown): DescribeOutcome {
  const cleaned = cleanDescription(raw, MAX_SHEET_DESCRIPTION_CHARS);
  if ('error' in cleaned) return { fail: 'bad_request', message: cleaned.error };
  const gone = { fail: 'not_found', message: 'Sheet not found' } as const;
  if (!verifySheetOwnership(sheetId, userId)) return gone;
  const changed = db.prepare(`UPDATE sheets SET description = ?, updated_at = datetime('now'),
      data_version = data_version + 1 WHERE id = ? AND user_id = ?`).run(cleaned.text, sheetId, userId).changes;
  if (changed) {
    const what = cleaned.text ? 'Described the sheet' : "Removed the sheet's description";
    logSheetChange(sheetId, userId, 'description', what, { detail: { description: cleaned.text } });
  }
  return changed ? { ok: { description: cleaned.text } } : gone;
}
