import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { getSheetColumns } from '../lib/sql-helpers';
import { getLockedRunColumns } from '../routes/sheets-shared';
import { isWebhookRawColumn } from '../lib/webhook-columns';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';

export interface TransferColumnPlan {
  sourceToDestination: Map<string, string>;
  destinationColumns: string[];
  finalOrder: string[];
  // Destination columns this transfer will create (create_missing mode).
  createdColumns: string[];
  // Webhook provenance markers no destination row currently carries: the
  // transfer must materialize them as blank cells or the read path self-heals
  // them straight back out of the column_order this plan writes.
  ghostMarkers: string[];
}

export function planTransferColumns(
  sourceSheetId: string,
  destinationSheetId: string,
  userId: string,
  mapping: Record<string, string>,
  mode: 'require_existing' | 'create_missing',
  pristine: boolean,
  subset?: string[],
): TransferColumnPlan | { error: string } {
  const sourceColumns = getSheetColumns(sourceSheetId, userId, false);
  const sourceSet = new Set(sourceColumns);
  if (subset) {
    const unknownSubset = subset.filter(c => !sourceSet.has(c));
    if (unknownSubset.length) return { error: `Unknown source column(s): ${unknownSubset.join(', ')}` };
    if (new Set(subset).size !== subset.length) return { error: 'columns must not contain duplicates' };
  }
  const copied = subset ? new Set(subset) : sourceSet;
  const unknownMappings = Object.keys(mapping).filter(c => !copied.has(c));
  if (unknownMappings.length) {
    return { error: `column_mapping references column(s) not being transferred: ${unknownMappings.join(', ')}` };
  }
  const sourceToDestination = new Map<string, string>();
  for (const source of sourceColumns.filter(c => copied.has(c))) {
    // Own-property read: mapping is a plain JSON object, so a source column
    // named "constructor"/"__proto__" would otherwise resolve the inherited
    // prototype member instead of falling back to its own name.
    const raw = Object.prototype.hasOwnProperty.call(mapping, source) ? mapping[source] : source;
    const checked = sanitizeAndValidateColumnName(raw);
    if ('error' in checked) return { error: checked.error };
    sourceToDestination.set(source, checked.name);
  }
  const destinationColumns = [...sourceToDestination.values()];
  for (let i = 0; i < destinationColumns.length; i++) {
    const collision = findColumnNameCollision(destinationColumns[i], destinationColumns.slice(0, i));
    if (collision) return { error: columnCollisionMessage(destinationColumns[i], collision) };
  }
  const existing = pristine ? [] : getSheetColumns(destinationSheetId, userId, false);
  // Reserve the destination's webhook provenance marker even when the sheet is
  // currently empty (zero rows self-heal every column out of the read path, and
  // this plan's finalOrder REPLACES column_order): the marker must survive the
  // overwrite, count toward the 80-column cap, and collide with case-variants —
  // the next webhook delivery re-materializes its key regardless.
  const markers = db.prepare(
    'SELECT raw_column_name AS name FROM webhook_sources WHERE sheet_id = ? AND user_id = ? AND raw_column_name IS NOT NULL',
  ).all(destinationSheetId, userId) as Array<{ name: string }>;
  const ghostMarkers: string[] = [];
  for (const { name } of markers) {
    if (existing.includes(name)) continue;
    existing.push(name);
    ghostMarkers.push(name);
  }
  const newColumns: string[] = [];
  for (const column of destinationColumns) {
    if (isWebhookRawColumn(destinationSheetId, userId, column)) {
      return { error: `Webhook provenance column cannot be written directly: ${column}` };
    }
    if (existing.includes(column)) continue;
    const collision = findColumnNameCollision(column, existing);
    if (collision) return { error: columnCollisionMessage(column, collision) };
    if (mode === 'require_existing') return { error: `Unknown destination column: ${column}` };
    newColumns.push(column);
  }
  const locked = getLockedRunColumns(destinationSheetId, userId);
  const lockedHits = destinationColumns.filter(c => locked.has(c));
  if (lockedHits.length) return { error: `An active run owns column(s): ${lockedHits.join(', ')}` };
  if (existing.length + newColumns.length > MAX_COLUMNS_PER_SHEET) {
    return { error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet).` };
  }
  return {
    sourceToDestination, destinationColumns, ghostMarkers,
    finalOrder: [...existing, ...newColumns],
    createdColumns: newColumns,
  };
}

export function applyTransferColumnOrder(
  sheetId: string, userId: string, order: string[],
): void {
  db.prepare(
    "UPDATE sheets SET column_order = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).run(JSON.stringify(order), sheetId, userId);
}
