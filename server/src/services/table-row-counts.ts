// The row counts the home (GET /api/tables) and GET /v1/tables and list_tables answer, never counted on the
// request (lib/row-counts.ts).
// - The home answers at once: a sheet whose rows changed since its last count shows that count with
//   row_count_updating, and the home waits for the new one (homeCountsWhenMade, held up to ROW_COUNT_HOLD_MS).
// - GET /v1/tables and list_tables wait for the new counts, their sheets counted first, up to ROW_COUNT_API_WAIT_MS:
//   a sheet still being counted then answers its last count with row_count_updating: true (it may be out of date).
import { db } from '../lib/db';
import {
  COUNT_COLUMNS, countsMade, rowCounts, rowCountsNow, type CountedSheet, type RowCount,
} from '../lib/row-counts';
import { ROW_COUNT_API_WAIT_MS, ROW_COUNT_HOLD_MS } from '../lib/constants-row-counts';

export interface LiveSheet extends CountedSheet { table_id: string; name: string; position: number }

// The user's sheets not in the trash (a table in the trash has its sheets there too), by table and position. A
// test's hidden copy isn't one, and a hidden working table's (a setup call's) aren't listed.
export const liveSheets = (userId: string): LiveSheet[] => db.prepare(`SELECT id, table_id, name, position,
  ${COUNT_COLUMNS} FROM sheets WHERE user_id = ? AND trash_id IS NULL AND test_of IS NULL
  AND table_id NOT IN (SELECT id FROM tables WHERE hidden = 1) ORDER BY table_id, position`)
  .all(userId) as LiveSheet[];

export interface TableCount { id: string; row_count: number; row_count_updating: boolean }

function byTable(sheets: LiveSheet[], counts: Map<string, RowCount>): Map<string, TableCount> {
  const out = new Map<string, TableCount>();
  for (const s of sheets) {
    const c = counts.get(s.id)!;
    const t = out.get(s.table_id) ?? { id: s.table_id, row_count: 0, row_count_updating: false };
    t.row_count += c.rows;
    t.row_count_updating ||= c.updating;
    out.set(s.table_id, t);
  }
  return out;
}

// The home: each table's rows now, the sheets whose rows changed queued to be counted again.
export function homeCounts(userId: string, sheets: LiveSheet[]): Map<string, TableCount> {
  return byTable(sheets, rowCounts(userId, sheets));
}

// The home's wait: every table's rows once the counts it is waiting for are made, or after ROW_COUNT_HOLD_MS.
// Queues nothing: a count that lands with the rows changed again meanwhile is answered as it is.
export async function homeCountsWhenMade(userId: string): Promise<TableCount[]> {
  const sheets = liveSheets(userId);
  await countsMade(sheets.map(s => s.id), Date.now() + ROW_COUNT_HOLD_MS);
  const now = liveSheets(userId);
  return [...byTable(now, rowCountsNow(now)).values()];
}

// GET /v1/tables and list_tables: each sheet's rows, waited for (above).
export async function apiSheetCounts(userId: string, sheets: LiveSheet[]): Promise<Map<string, RowCount>> {
  rowCounts(userId, sheets, true);
  await countsMade(sheets.map(s => s.id), Date.now() + ROW_COUNT_API_WAIT_MS);
  return rowCountsNow(sheets);
}
