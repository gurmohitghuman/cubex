// Table create/rename/delete: ONE implementation for the UI routes
// (routes/tables.ts), /api/v1 (routes/api-v1-tables.ts) and the MCP
// manage_table tool. Callers map failures to their own status codes.
// Invariants preserved: per-user name uniqueness (conflict check + UNIQUE-
// constraint backstop) checked inside an IMMEDIATE txn, delete aborts
// active runs BEFORE the FK cascade and drops webhook buckets after commit.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { validateTableName } from '../lib/table-validation';
import { abortRunsForTable } from './run-control';
import { dropBucketsForSheets } from '../lib/webhook-bucket';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { normalizeNameSpacing } from '../lib/name-safety';

export type TableCrudFail = {
  fail: 'conflict' | 'not_found' | 'bad_request';
  message: string;
};

export type CreateTableOutcome =
  | { ok: { id: string; name: string; sheetId: string } }
  | TableCrudFail;

// Creates the table plus its first sheet, deliberately EMPTY (0 rows/cols):
// add-first-column creates row 0 and the empty-state UI handles the rest. Only
// the add-sheet route seeds a starter grid; seeding here would change
// import/onboarding semantics app-wide.
export function createTable(userId: string, rawName: unknown): CreateTableOutcome {
  const validationErr = validateTableName(rawName);
  if (validationErr) return { fail: 'bad_request', message: validationErr };
  const name = normalizeNameSpacing(rawName as string);

  const tableId = uuidv4();
  const sheetId = uuidv4();
  let fail: TableCrudFail | null = null;
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM tables WHERE user_id = ? AND name = ? LIMIT 1').get(userId, name)) {
      fail = { fail: 'conflict', message: `A table named "${name}" already exists` };
      return;
    }
    db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tableId, userId, name);
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, position) VALUES (?, ?, ?, ?, 0)')
      .run(sheetId, tableId, userId, 'Sheet1');
  }).immediate();
  if (fail) return fail;
  return { ok: { id: tableId, name, sheetId } };
}

export type RenameTableOutcome = { ok: { id: string; name: string } } | TableCrudFail;

// Conflict check + UPDATE in one IMMEDIATE txn (a concurrent create/rename
// between the two would surface as a unique-index 500 instead of the promised
// conflict), plus a constraint-catch as the backstop.
export function renameTable(userId: string, tableId: string, rawName: unknown): RenameTableOutcome {
  const validationErr = validateTableName(rawName);
  if (validationErr) return { fail: 'bad_request', message: validationErr };
  const name = normalizeNameSpacing(rawName as string);

  let fail: TableCrudFail | null = null;
  try {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM tables WHERE user_id = ? AND name = ? AND id != ? LIMIT 1')
        .get(userId, name, tableId)) {
        fail = { fail: 'conflict', message: `A table named "${name}" already exists` };
        return;
      }
      const result = db.prepare(
        "UPDATE tables SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      ).run(name, tableId, userId);
      if (result.changes === 0) fail = { fail: 'not_found', message: 'Table not found' };
    }).immediate();
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      return { fail: 'conflict', message: 'A table with this name already exists' };
    }
    throw error;
  }
  if (fail) return fail;
  return { ok: { id: tableId, name } };
}

export type DeleteTableOutcome = { ok: { deleted: true } } | TableCrudFail;

// Abort active runs FIRST (workers must not keep writing into rows the FK
// cascade is about to wipe); capture webhook source ids BEFORE the cascade
// removes them; drop their in-memory buckets after.
export function deleteTable(userId: string, tableId: string): DeleteTableOutcome {
  if (!db.prepare('SELECT id FROM tables WHERE id = ? AND user_id = ?').get(tableId, userId)) {
    return { fail: 'not_found', message: 'Table not found' };
  }
  const sheetIds = db.prepare('SELECT id FROM sheets WHERE table_id = ? AND user_id = ?').pluck().all(tableId, userId) as string[];
  const busy = sheetIds.map(sheetBusyWith).find(Boolean);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  abortRunsForTable(tableId);
  const sourceIds = (db.prepare(
    `SELECT ws.id FROM webhook_sources ws JOIN sheets s ON s.id = ws.sheet_id
     WHERE s.table_id = ? AND s.user_id = ? AND ws.user_id = ?`,
  ).all(tableId, userId, userId) as Array<{ id: string }>).map(r => r.id);
  db.prepare('DELETE FROM tables WHERE id = ? AND user_id = ?').run(tableId, userId);
  dropBucketsForSheets(sourceIds);
  return { ok: { deleted: true } };
}

export const tableFailHttpStatus = (f: TableCrudFail): number =>
  f.fail === 'not_found' ? 404 : f.fail === 'conflict' ? 409 : 400;
