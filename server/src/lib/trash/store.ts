// The trash's records (migration 036): one trash_items row per deletion, and
// the setting for how long they are kept. Services: trash-rows.ts (rows into
// a batch), trash-sheets.ts (a sheet or table kept whole), trash-restore*.ts,
// trash-purge.ts (gone for good), trash-read.ts.
import { db } from '../db';
import { currentActor } from '../actor';
import { TRASH_DAYS_DEFAULT, TRASH_DAYS_MAX } from '../constants';
import { v4 as uuidv4 } from 'uuid';

export type TrashKind = 'rows' | 'sheet' | 'table';
// How the rows went: the grid, delete_rows (REST/MCP), removing duplicates, a
// CSV import replacing the rows, transfer_rows moving them out; or the sheet
// or table itself was deleted.
export type TrashHow = 'grid' | 'api' | 'duplicates' | 'import' | 'transfer' | 'sheet' | 'table';
export type TrashState = 'moving' | 'kept' | 'restoring' | 'purging';

export interface TrashItem {
  id: number; user_id: string; kind: TrashKind; table_id: string; sheet_id: string | null;
  table_name: string; sheet_name: string | null; how: TrashHow; via: string; token_name: string | null;
  row_count: number; bytes: number; columns: string; row_generation: number | null; top_index: number | null;
  state: TrashState; restore_at: number | null; restored: number; deleted_at: string;
}

export function getTrashDays(userId: string): number {
  const row = db.prepare('SELECT trash_days FROM settings WHERE user_id = ?').get(userId) as
    { trash_days: number } | undefined;
  return row ? Math.max(0, Math.min(TRASH_DAYS_MAX, row.trash_days)) : TRASH_DAYS_DEFAULT;
}

export function setTrashDays(userId: string, days: number): void {
  db.transaction(() => {
    db.prepare('INSERT INTO settings (id, user_id) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING')
      .run(uuidv4(), userId);
    db.prepare("UPDATE settings SET trash_days = ?, updated_at = datetime('now') WHERE user_id = ?").run(days, userId);
  })();
}

export function getTrashItem(id: number, userId: string): TrashItem | undefined {
  return db.prepare('SELECT * FROM trash_items WHERE id = ? AND user_id = ?').get(id, userId) as TrashItem | undefined;
}

// A new item, recording who deleted it (lib/actor.ts). Call inside the
// transaction that deletes.
export function insertTrashItem(p: {
  userId: string; kind: TrashKind; how: TrashHow; tableId: string; sheetId: string | null;
  rowCount?: number; columns?: string[]; state?: TrashState;
}): number {
  const names = db.prepare(`SELECT t.name AS tbl, s.name AS sheet FROM tables t
    LEFT JOIN sheets s ON s.id = ? AND s.table_id = t.id WHERE t.id = ?`)
    .get(p.sheetId, p.tableId) as { tbl: string; sheet: string | null } | undefined;
  const actor = currentActor();
  const info = db.prepare(`INSERT INTO trash_items (user_id, kind, table_id, sheet_id, table_name, sheet_name, how,
      via, token_name, row_count, columns, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.userId, p.kind, p.tableId, p.sheetId, names?.tbl ?? '', names?.sheet ?? null, p.how,
      actor.via, actor.tokenName, p.rowCount ?? 0, JSON.stringify(p.columns ?? []), p.state ?? 'kept');
  return Number(info.lastInsertRowid);
}

// The sheet's table, its columns and its row_generation, for a new batch of its rows.
export function sheetFacts(sheetId: string, userId: string):
  { tableId: string; columns: string[]; generation: number } | null {
  const s = db.prepare('SELECT table_id, column_order, row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { table_id: string; column_order: string | null; row_generation: number } | undefined;
  if (!s) return null;
  let columns: string[] = [];
  try {
    const parsed = JSON.parse(s.column_order ?? '[]');
    if (Array.isArray(parsed)) columns = parsed.filter((c): c is string => typeof c === 'string');
  } catch { /* an unreadable list: the rows still keep their cells */ }
  return { tableId: s.table_id, columns, generation: s.row_generation };
}

export function setTrashState(id: number, state: TrashState): void {
  db.prepare('UPDATE trash_items SET state = ? WHERE id = ?').run(state, id);
}

// Whether something deleted now is kept: Settings keeps it at least a day.
export const trashKeeps = (userId: string): boolean => getTrashDays(userId) > 0;

// The day an item leaves the trash for good, as the API states it.
export function trashExpiry(deletedAt: string, days: number): string {
  const t = Date.parse(`${deletedAt.replace(' ', 'T')}Z`);
  return new Date(t + days * 86_400_000).toISOString();
}
