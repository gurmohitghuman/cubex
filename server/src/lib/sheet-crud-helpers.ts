import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { seedEmptySheet } from './seed-sheet';

// Shared helpers for the sheet (tab) CRUD routes in routes/tables-sheets.ts.

export type CreateSheetResult =
  | { ok: true; sheetId: string }
  | { ok: false; reason: 'conflict' };

// Atomic sheet-create: cap check + name-conflict + insert-right-of-afterSheetId with
// position normalization + seed, all in one BEGIN IMMEDIATE txn (race-safe against
// concurrent creates). Returns a result flag; the route maps it to a status code.
// `finalName` is resolved to the lowest-unused name inside the txn when omitted.
// `seed: false` (API/MCP creation) starts the sheet truly empty — 0 columns,
// 0 rows, the same valid shape as a table's first sheet — instead of the UI's
// "Column 1" + blank-row scaffold that agents immediately have to undo.
export function createSheetTxn(
  tableId: string, userId: string, trimmedName: string | undefined, afterSheetId: string | undefined,
  options: { seed?: boolean } = {},
): CreateSheetResult {
  const sheetId = uuidv4();
  let result: CreateSheetResult = { ok: true, sheetId };
  db.transaction(() => {
    const finalName = trimmedName ?? lowestUnusedSheetName(tableId, userId);
    if (sheetNameTaken(tableId, userId, finalName)) { result = { ok: false, reason: 'conflict' }; return; }

    // Insert right of afterSheetId (Google's insert-right-of-active); omitted -> append.
    // Then normalize all positions to 0..n-1 (gap-free, race-safe).
    const siblings = db.prepare(
      'SELECT id FROM sheets WHERE table_id = ? AND user_id = ? ORDER BY position ASC',
    ).all(tableId, userId) as Array<{ id: string }>;
    let insertAt = siblings.length;
    if (afterSheetId) {
      const idx = siblings.findIndex(s => s.id === afterSheetId);
      if (idx !== -1) insertAt = idx + 1;
    }
    const ordered = [
      ...siblings.slice(0, insertAt).map(s => s.id),
      sheetId,
      ...siblings.slice(insertAt).map(s => s.id),
    ];
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, position) VALUES (?, ?, ?, ?, ?)')
      .run(sheetId, tableId, userId, finalName, insertAt);
    const setPos = db.prepare('UPDATE sheets SET position = ? WHERE id = ? AND user_id = ?');
    ordered.forEach((id, i) => setPos.run(i, id, userId));

    if (options.seed !== false) seedEmptySheet(sheetId, userId);
  }).immediate();
  return result;
}

export function verifyTableOwnership(tableId: string, userId: string): boolean {
  return !!db.prepare('SELECT 1 FROM tables WHERE id = ? AND user_id = ?').get(tableId, userId);
}

export function verifySheetInTable(sheetId: string, tableId: string, userId: string): boolean {
  return !!db.prepare(
    'SELECT 1 FROM sheets WHERE id = ? AND table_id = ? AND user_id = ?',
  ).get(sheetId, tableId, userId);
}

// Client-facing sheet/table column lists. sort_state is always NULL now (sort is
// a one-time physical reorder, nothing writes it); it stays in the payload so
// responses keep their shape. NEVER `SELECT *` for a row that goes
// out in a response: the row also carries the internal `user_id` (and, for
// sheets, `column_order`), which the client never reads and shouldn't leak in
// REST / MCP / structure-op responses (needless internal-schema exposure —
// flagged in a security review). Keep these in sync with the client `Sheet` /
// `Table` interfaces (utils/api/types.ts).
const SHEET_CLIENT_COLUMNS =
  `id, table_id, name, position, created_at, updated_at,
   sort_state, empty_filter, column_filters,
   default_ai_model, default_ai_concurrency, row_generation, data_version`;
const TABLE_CLIENT_COLUMNS = `id, name, created_at, updated_at`;

export function listSheets(tableId: string, userId: string): unknown[] {
  return db.prepare(
    `SELECT ${SHEET_CLIENT_COLUMNS} FROM sheets WHERE table_id = ? AND user_id = ? ORDER BY position ASC`,
  ).all(tableId, userId);
}

// One sheet in the client-facing shape, for create/rename responses that echo the
// affected sheet. Scoped by userId (defense in depth — callers already verify
// ownership, but never trust a bare id) and never `SELECT *`.
export function getSheetForClient(sheetId: string, userId: string): unknown {
  return db.prepare(
    `SELECT ${SHEET_CLIENT_COLUMNS} FROM sheets WHERE id = ? AND user_id = ?`,
  ).get(sheetId, userId);
}

// One table in the client-facing shape (no user_id), for create/rename/get
// responses. Scoped by userId. Callers add `sheets` / `row_count` as needed.
export function getTableForClient(tableId: string, userId: string): unknown {
  return db.prepare(
    `SELECT ${TABLE_CLIENT_COLUMNS} FROM tables WHERE id = ? AND user_id = ?`,
  ).get(tableId, userId);
}

// True if another sheet in the table already uses this name (case-insensitive).
// excludeId lets rename ignore the row being renamed.
export function sheetNameTaken(
  tableId: string, userId: string, name: string, excludeId?: string,
): boolean {
  if (excludeId) {
    return !!db.prepare(
      'SELECT 1 FROM sheets WHERE table_id = ? AND user_id = ? AND LOWER(name) = LOWER(?) AND id != ? LIMIT 1',
    ).get(tableId, userId, name, excludeId);
  }
  return !!db.prepare(
    'SELECT 1 FROM sheets WHERE table_id = ? AND user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
  ).get(tableId, userId, name);
}

// Lowest-unused "Sheet<N>" within the table (Google Sheets behaviour: after churn,
// reuse the gap rather than monotonically climbing to Sheet14).
export function lowestUnusedSheetName(tableId: string, userId: string): string {
  const names = new Set(
    (db.prepare('SELECT name FROM sheets WHERE table_id = ? AND user_id = ?')
      .all(tableId, userId) as Array<{ name: string }>).map(r => r.name.toLowerCase()),
  );
  for (let n = 1; ; n++) {
    if (!names.has(`sheet${n}`)) return `Sheet${n}`;
  }
}
