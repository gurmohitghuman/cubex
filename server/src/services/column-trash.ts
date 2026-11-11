// A deleted column going to the trash (migration 054). Inside the delete's transaction, before it cleans
// anything up (services/column-delete.ts): one trash item of kind 'column', 'moving', holding the column's
// name, its place in column_order, its description, its own setup and auto-run as a setup version reads
// them (setup-version-snapshot.ts: an AI column's newest run settings with its outputs and "(Data)", an HTTP
// API, enrichment or waterfall column's newest config with its fields, a clean, formula or lookup record),
// and what referred to it (lib/trash/column-refs.ts). Its cells then move in by the delete's strip, a slice
// at a time (lib/trash/column-move.ts); the last slice seals it 'kept'. With Settings keeping deleted things
// 0 days there is no item and the column goes at once, as before.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { insertTrashItem, sheetFacts, trashKeeps } from '../lib/trash/store';
import { columnRefs } from '../lib/trash/column-refs';
import type { VersionColumn } from '../lib/setup-versions/spec';
import { snapshotSheet } from './setup-version-snapshot';

export function openColumnItem(sheetId: string, userId: string, column: string): number | null {
  const facts = sheetFacts(sheetId, userId);
  if (!facts || !trashKeeps(userId)) return null;
  const position = getSheetColumns(sheetId, userId, false).indexOf(column);
  const own: VersionColumn = snapshotSheet(sheetId, userId).columns.find(c => c.name === column)
    ?? { name: column, description: null, fill: null, autoRun: null };
  const refs = columnRefs(sheetId, userId, column);
  const id = insertTrashItem({
    userId, kind: 'column', how: 'column', tableId: facts.tableId, sheetId, columns: [column], state: 'moving',
  });
  db.prepare(`UPDATE trash_items SET column_name = ?, column_position = ?, column_setup = ?, column_dropped = ?
    WHERE id = ?`).run(column, Math.max(0, position), JSON.stringify(own), JSON.stringify(refs), id);
  return id;
}

