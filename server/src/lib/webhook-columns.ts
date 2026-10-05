import { db } from './db';

// Webhook ↔ column lifecycle cascades, called from the column rename/delete routes
// (sheets-columns-order.ts / sheets-columns-mutate.ts). A webhook's columns are
// tracked in two places — webhook_sources.raw_column_name (the marker column) and
// webhook_mappings.column_name (each mapped column) — and neither is an FK, so
// rename/delete must keep them in sync the same way http_column_associations does.

// Is `columnName` the raw marker column of this sheet's webhook? Used to BLOCK
// deleting it while a source exists (it's the row-provenance affordance — deleting
// it would strand the raw-view surface for past webhook rows).
export function isWebhookRawColumn(sheetId: string, userId: string, columnName: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS x FROM webhook_sources WHERE sheet_id = ? AND user_id = ? AND raw_column_name = ?',
  ).get(sheetId, userId, columnName);
  return !!row;
}

// On column RENAME: keep webhook column references in sync. Updates the mapped
// column name in webhook_mappings AND the raw marker name in webhook_sources.
// Call INSIDE the rename transaction (like the http_column_associations updates).
export function renameWebhookColumnRefs(
  sheetId: string, userId: string, oldName: string, newName: string,
): void {
  db.prepare(
    `UPDATE webhook_mappings SET column_name = ?
       WHERE user_id = ? AND column_name = ?
         AND source_id IN (SELECT id FROM webhook_sources WHERE sheet_id = ? AND user_id = ?)`,
  ).run(newName, userId, oldName, sheetId, userId);
  db.prepare(
    `UPDATE webhook_sources SET raw_column_name = ?
       WHERE sheet_id = ? AND user_id = ? AND raw_column_name = ?`,
  ).run(newName, sheetId, userId, oldName);
}

// On column DELETE: drop any webhook_mappings that targeted it (the column + its
// data are being removed; the mapping would dangle). Call INSIDE the delete txn.
// The RAW marker column is protected separately (isWebhookRawColumn -> 400).
export function deleteWebhookMappingsForColumn(
  sheetId: string, userId: string, columnName: string,
): void {
  db.prepare(
    `DELETE FROM webhook_mappings
       WHERE user_id = ? AND column_name = ?
         AND source_id IN (SELECT id FROM webhook_sources WHERE sheet_id = ? AND user_id = ?)`,
  ).run(userId, columnName, sheetId, userId);
}
