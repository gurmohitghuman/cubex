// Adding a field a sheet's webhook fills (POST /api/sheets/:id/webhook/mappings):
// the field's new column and its mapping, in one immediate transaction. Listing
// the column is what creates it (lib/sheet-columns.ts): no row is touched, so it
// costs the same on a million-row sheet as on an empty one, rows already there
// read the new column as empty, and an empty sheet stays empty (its first event
// is row 0, as when the webhook was made: lib/webhook-service.ts).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, touchSheet } from '../lib/sql-helpers';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';
import { validateMappingPath } from '../lib/jsonpath-extract';
import { logSheetChange } from '../lib/change-log';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';

export interface WebhookMappingInput { jsonPath: string; columnName: string; valueMode: 'scalar' | 'json' }

// error: what the route answers (400 invalid, 409 busy).
// column: the new column's name as saved (spacing normalized).
export type WebhookMappingAdd = { ok: true; column: string } | { fail: 'invalid' | 'busy'; error: string };

// The caller has verified the sheet is the user's and found its webhook source.
export function addWebhookMapping(
  sheetId: string, userId: string, sourceId: string, input: WebhookMappingInput,
): WebhookMappingAdd {
  // First, as in the clean and formula services: the sheets router refuses a
  // busy sheet too, but Express yields between its routers, so a sort, an
  // import or a column rename may have started since. Refused (409 busy) until
  // it finishes, before the columns are read (on a sheet from before the column
  // list, reading them writes it). Everything from here to the write is synchronous.
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'busy', error: busyMessage(busy) };

  // Validate the path against the client builder grammar + length cap BEFORE
  // storing it — a stored mapping path runs on every unauthenticated webhook POST,
  // so a hand-crafted filter/script path must be rejected here, not at run time.
  const pathCheck = validateMappingPath(input.jsonPath);
  if (!pathCheck.ok) return { fail: 'invalid', error: pathCheck.reason };

  const nameCheck = sanitizeAndValidateColumnName(input.columnName);
  if ('error' in nameCheck) return { fail: 'invalid', error: nameCheck.error };
  const columnName = nameCheck.name;

  const existingCols = getSheetColumns(sheetId, userId);
  const collision = findColumnNameCollision(columnName, existingCols);
  if (collision) return { fail: 'invalid', error: columnCollisionMessage(columnName, collision) };
  // The webhook's own columns count even when a CSV replace has unlisted them (its next event lists them again,
  // lib/webhook-ingest.ts): its marker, which each event stamps (a field there would overwrite the stamp), and the
  // columns its fields fill (one more would break the one-field-a-column index with a 500).
  const marker = db.prepare('SELECT raw_column_name FROM webhook_sources WHERE id = ?').pluck().get(sourceId) as
    string | undefined;
  if (marker && findColumnNameCollision(columnName, [marker])) {
    return { fail: 'invalid', error: `"${marker}" is the webhook's own column, the time each event came in: pick `
      + 'another name.' };
  }
  const filled = db.prepare('SELECT column_name FROM webhook_mappings WHERE source_id = ?').pluck()
    .all(sourceId) as string[];
  const taken = findColumnNameCollision(columnName, filled);
  if (taken) {
    return { fail: 'invalid', error: `The webhook already fills "${taken.clash}" (an import took it off the sheet; its `
      + 'next event puts it back): remove that field first, or pick another name.' };
  }
  if (existingCols.length >= MAX_COLUMNS_PER_SHEET) {
    return { fail: 'invalid', error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet).` };
  }

  db.transaction(() => {
    appendColumnsToOrder(sheetId, userId, [columnName]);
    db.prepare(
      `INSERT INTO webhook_mappings (id, source_id, user_id, json_path, column_name, value_mode)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(uuidv4(), sourceId, userId, input.jsonPath, columnName, input.valueMode);
    touchSheet(sheetId, userId);
    logSheetChange(sheetId, userId, 'webhook', `The webhook fills "${columnName}" from ${input.jsonPath}`,
      { column: columnName });
  }).immediate();
  return { ok: true, column: columnName };
}
