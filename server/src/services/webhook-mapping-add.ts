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
export type WebhookMappingAdd = { ok: true } | { fail: 'invalid' | 'busy'; error?: string };

// The caller has verified the sheet is the user's and found its webhook source.
export function addWebhookMapping(
  sheetId: string, userId: string, sourceId: string, input: WebhookMappingInput,
): WebhookMappingAdd {
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
  if (existingCols.length >= MAX_COLUMNS_PER_SHEET) {
    return { fail: 'invalid', error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet).` };
  }

  // The sheets router refuses a busy sheet first, but Express yields between
  // its routers, so a sort, an import or a column rename may have started
  // since. Like adding any column, this waits for it (a CSV replace sets the
  // columns when it ends).
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'busy', error: busyMessage(busy) };

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
  return { ok: true };
}
