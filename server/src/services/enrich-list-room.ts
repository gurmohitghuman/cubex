// Room in a list job's destination sheet: its rows plus the results waiting
// to be added there, against the row limit. A full destination stops the run
// before it buys more results (enrich-runner.ts), keeps the results already
// bought waiting until there's room (enrich-list-drain.ts), and holds Resume
// and auto-run until rows are deleted there.
import { db } from '../lib/db';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { countRows } from '../lib/sql-helpers';

export interface DestRoom { name: string; rows: number; waiting: number; room: number }

// Results still to add into the sheet (waiting for fields too: they will be).
function waitingInto(destSheetId: string, userId: string): number {
  return db.prepare(`SELECT IFNULL(SUM(item_count), 0) FROM enrichment_list_items
    WHERE dest_sheet_id = ? AND status = 'pending' AND user_id = ?`).pluck().get(destSheetId, userId) as number;
}

export function destRoom(destSheetId: string, userId: string): DestRoom | null {
  const name = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(destSheetId, userId) as string | undefined;
  if (name === undefined) return null;
  const rows = countRows(destSheetId, userId);
  const waiting = waitingInto(destSheetId, userId);
  return { name, rows, waiting, room: MAX_ROWS_PER_SHEET - rows - waiting };
}

export const destFullMessage = (name: string): string =>
  `${name} is full (${MAX_ROWS_PER_SHEET.toLocaleString('en-US')} rows). Delete rows there, then Resume.`;
