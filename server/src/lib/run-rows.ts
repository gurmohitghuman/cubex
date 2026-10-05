import { db } from './db';
import { jsonPath, parseRowData } from './sql-rows';
import { yieldToRequests } from './slices';

// The rows an AI or HTTP run still has to process, read a page at a time
// instead of loading the whole sheet into the worker: a run over a million rows
// holds one page in memory. `placeholderColumn` narrows to rows whose cell still
// holds the '⏳ Processing...' placeholder (run start seeds it on every target,
// processing replaces it, so these are exactly the unfinished rows; null for a
// legacy run without one). `targets` narrows a rerun to its rows. Rows come in
// row order, and each page is read fresh, so it reflects edits made meanwhile.
export interface RunRow { rowIndex: number; data: Record<string, string> }

const PLACEHOLDER = '⏳ Processing...';
const PAGE_ROWS = 500;
// Up to this many targets are looked up by position (row_index IN …); a bigger
// rerun walks the sheet in order and skips rows outside its targets.
const TARGET_LOOKUP_MAX = 50_000;

export async function* runRows(
  sheetId: string, userId: string, placeholderColumn: string | null, targets: number[] | null,
): AsyncGenerator<RunRow> {
  const unfinished = (r: RunRow) => !placeholderColumn || r.data[placeholderColumn] === PLACEHOLDER;
  if (targets && targets.length <= TARGET_LOOKUP_MAX) {
    const sorted = [...new Set(targets)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += PAGE_ROWS) {
      const chunk = sorted.slice(i, i + PAGE_ROWS);
      const rows = db.prepare(
        `SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (${chunk.map(() => '?').join(',')}) ORDER BY row_index`,
      ).all(sheetId, userId, ...chunk) as Array<{ row_index: number; data: string }>;
      for (const r of rows) {
        const row = { rowIndex: r.row_index, data: parseRowData(r.data) };
        if (unfinished(row)) yield row;
      }
    }
    return;
  }
  const inTargets = targets ? new Set(targets) : null;
  const page = placeholderColumn
    ? db.prepare(`SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
        AND json_extract(data, ?) = '⏳ Processing...' ORDER BY row_index LIMIT ?`)
    : db.prepare('SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?');
  const path = placeholderColumn ? [jsonPath(placeholderColumn)] : [];
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = page.all(sheetId, userId, after, ...path, PAGE_ROWS) as Array<{ row_index: number; data: string }>;
    if (rows.length === 0) return;
    after = rows[rows.length - 1].row_index;
    for (const r of rows) {
      if (!inTargets || inTargets.has(r.row_index)) yield { rowIndex: r.row_index, data: parseRowData(r.data) };
    }
  }
}

// How many rows runRows would yield, without reading their data into JS: the
// starting point of a resumed run's progress.
export function countRunRows(
  sheetId: string, userId: string, placeholderColumn: string | null, targets: number[] | null,
): number {
  if (!targets) {
    return placeholderColumn
      ? (db.prepare(`SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?
          AND json_extract(data, ?) = '⏳ Processing...'`).get(sheetId, userId, jsonPath(placeholderColumn)) as { c: number }).c
      : (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?').get(sheetId, userId) as { c: number }).c;
  }
  const inTargets = new Set(targets);
  const page = placeholderColumn
    ? db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
        AND json_extract(data, ?) = '⏳ Processing...' ORDER BY row_index LIMIT 10000`).pluck()
    : db.prepare('SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT 10000').pluck();
  const path = placeholderColumn ? [jsonPath(placeholderColumn)] : [];
  let count = 0;
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const indexes = page.all(sheetId, userId, after, ...path) as number[];
    if (indexes.length === 0) return count;
    for (const i of indexes) if (inTargets.has(i)) count++;
    after = indexes[indexes.length - 1];
  }
}

// Of the `wanted` row_index values, those that exist, ascending and distinct.
export function existingRowIndexes(sheetId: string, userId: string, wanted: number[]): number[] {
  const sorted = [...new Set(wanted)].sort((a, b) => a - b);
  const found: number[] = [];
  for (let i = 0; i < sorted.length; i += 500) {
    const chunk = sorted.slice(i, i + 500);
    found.push(...db.prepare(
      `SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (${chunk.map(() => '?').join(',')}) ORDER BY row_index`,
    ).pluck().all(sheetId, userId, ...chunk) as number[]);
  }
  return found;
}

const SCAN_PAGE_ROWS = 20_000;

// The rows whose `column` cell passes `keep` (a rerun's targets), ascending.
// Read a page at a time between requests, so choosing targets on a
// million-row sheet neither freezes the server nor holds the rows in memory.
export async function rowsWhere(
  sheetId: string, userId: string, column: string, keep: (value: unknown) => boolean,
): Promise<number[]> {
  const page = db.prepare(`
    SELECT row_index, json_extract(data, ?) FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?
  `).raw();
  const path = jsonPath(column);
  const out: number[] = [];
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = page.all(path, sheetId, userId, after, SCAN_PAGE_ROWS) as Array<[number, unknown]>;
    for (const [rowIndex, value] of rows) if (keep(value)) out.push(rowIndex);
    if (rows.length < SCAN_PAGE_ROWS) return out;
    after = rows[rows.length - 1][0];
    await yieldToRequests();
  }
}
