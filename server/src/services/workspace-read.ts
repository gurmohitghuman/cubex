// Read services for the programmatic surfaces (/api/v1 + MCP) — extracted from
// routes/api-v1-tables.ts / api-v1-sheets.ts so both share one implementation.
import { db } from '../lib/db';
import { getSheetColumns, countRows, parseRowData } from '../lib/sql-helpers';

export interface SheetSummary { id: string; name: string; position: number; row_count: number }
export interface TableSummary {
  id: string; name: string; created_at: string; updated_at: string; sheets: SheetSummary[];
}

export function listTablesWithSheets(userId: string): TableSummary[] {
  const tables = db.prepare(
    'SELECT id, name, created_at, updated_at FROM tables WHERE user_id = ? ORDER BY created_at DESC',
  ).all(userId) as Array<{ id: string; name: string; created_at: string; updated_at: string }>;

  const sheets = db.prepare(`
    SELECT s.id, s.table_id, s.name, s.position,
           (SELECT COUNT(*) FROM rows r WHERE r.sheet_id = s.id AND r.user_id = s.user_id) AS row_count
    FROM sheets s WHERE s.user_id = ? ORDER BY s.table_id, s.position ASC
  `).all(userId) as Array<SheetSummary & { table_id: string }>;

  const byTable = new Map<string, SheetSummary[]>();
  for (const s of sheets) {
    if (!byTable.has(s.table_id)) byTable.set(s.table_id, []);
    byTable.get(s.table_id)!.push({ id: s.id, name: s.name, position: s.position, row_count: s.row_count });
  }
  return tables.map(t => ({ ...t, sheets: byTable.get(t.id) ?? [] }));
}

export interface SheetMeta {
  id: string; table_id: string; name: string;
  columns: string[]; row_count: number; data_version: number;
  default_ai_model: string | null; // sheet override; account default applies when null
  row_generation: number;
}

export function getSheetMeta(sheetId: string, userId: string): SheetMeta | null {
  const sheet = db.prepare(
    'SELECT id, table_id, name, data_version, row_generation, default_ai_model FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as {
    id: string; table_id: string; name: string; data_version: number; row_generation: number; default_ai_model: string | null;
  } | undefined;
  if (!sheet) return null;
  return {
    id: sheet.id,
    table_id: sheet.table_id,
    name: sheet.name,
    columns: getSheetColumns(sheetId, userId),
    row_count: countRows(sheetId, userId),
    data_version: sheet.data_version,
    row_generation: sheet.row_generation,
    default_ai_model: sheet.default_ai_model,
  };
}

export interface RowsPage {
  rows: Array<{ id: string; index: number; data: Record<string, string> }>;
  next_cursor: number | null;
  data_version: number;
  row_generation: number;
}

// Keyset paging by row_index: stable under appends, cheap on the
// (sheet_id, row_index) index. `after` = the index of the last row already
// received (-1 for the first page). Caller has verified sheet ownership.
export function readRowsPage(sheetId: string, userId: string, after: number, limit: number): RowsPage {
  const versions = db.prepare(
    'SELECT data_version, row_generation FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as { data_version: number; row_generation: number };
  const fetched = db.prepare(`
    SELECT id, row_index, data FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index ASC LIMIT ?
  `).all(sheetId, userId, after, limit + 1) as Array<{ id: string; row_index: number; data: string }>;
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  return {
    rows: rows.map(r => ({ id: r.id, index: r.row_index, data: parseRowData(r.data) })),
    // Full page → there may be more; a short page is definitive end-of-sheet.
    next_cursor: hasMore ? rows[rows.length - 1].row_index : null,
    ...versions,
  };
}
