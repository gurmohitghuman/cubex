// Reading the trash: the Trash page, GET /api/v1/trash and MCP list_trash.
// One list for the whole account (newest first, searchable by name and by
// who deleted it), and a batch's rows a page at a time, searchable by one
// column (or any cell) a slice of rows per call.
import { db } from '../lib/db';
import {
  TRASH_LIST_PAGE, TRASH_ROWS_PAGE_DEFAULT, TRASH_ROWS_PAGE_MAX, TRASH_SEARCH_SCAN_ROWS,
} from '../lib/constants';
import { jsonPath, parseRowData } from '../lib/sql-helpers';
import { actorLabel, type Via } from '../lib/actor';
import { getTrashDays, getTrashItem, trashExpiry, type TrashItem } from '../lib/trash/store';
import { batchColumns } from '../lib/trash/restore-rows';

export interface TrashEntry {
  id: number; kind: TrashItem['kind']; state: TrashItem['state'];
  deleted_at: string; expires_at: string;
  table_id: string; table_name: string; sheet_id: string | null; sheet_name: string | null;
  how: TrashItem['how']; by: string; via: string; token_name: string | null;
  rows: number; bytes: number; columns: string[];
  restored_so_far?: number;
  // Why it can't be restored right now (its sheet or table is in the trash too).
  blocked?: string;
  // What to know first: rows moved to another sheet are still there.
  note?: string;
}

const iso = (at: string) => `${at.replace(' ', 'T')}Z`;

function entryOf(item: TrashItem, days: number): TrashEntry {
  return {
    id: item.id, kind: item.kind, state: item.state, deleted_at: iso(item.deleted_at),
    expires_at: trashExpiry(item.deleted_at, days),
    table_id: item.table_id, table_name: item.table_name, sheet_id: item.sheet_id, sheet_name: item.sheet_name,
    how: item.how, by: actorLabel(item.via as Via, item.token_name), via: item.via, token_name: item.token_name,
    rows: item.row_count, bytes: item.bytes, columns: item.kind === 'rows' ? batchColumns(item) : [],
    ...(item.state === 'restoring' ? { restored_so_far: item.restored } : {}),
    ...(item.how === 'transfer'
      ? { note: 'These rows were moved to another sheet and are still there: restoring them here keeps both.' } : {}),
    ...blockedBy(item),
  };
}

function blockedBy(item: TrashItem): { blocked?: string } {
  const holder = item.kind === 'rows'
    ? db.prepare(`SELECT h.kind, h.sheet_name, h.table_name FROM sheets s JOIN trash_items h ON h.id = s.trash_id
        WHERE s.id = ?`).get(item.sheet_id)
    : item.kind === 'sheet'
      ? db.prepare(`SELECT h.kind, h.sheet_name, h.table_name FROM tables t JOIN trash_items h ON h.id = t.trash_id
          WHERE t.id = ?`).get(item.table_id)
      : undefined;
  const h = holder as { kind: string; sheet_name: string | null; table_name: string } | undefined;
  if (!h) return {};
  return h.kind === 'table'
    ? { blocked: `Its table "${h.table_name}" is in the trash: restore the table first.` }
    : { blocked: `Its sheet "${h.sheet_name}" is in the trash: restore the sheet first.` };
}

export interface TrashList { items: TrashEntry[]; kept_days: number; next_before: number | null; total_bytes: number }

// q: words in a table or sheet name, or the access token that deleted it.
export function listTrash(
  userId: string,
  opts: { q?: string; kind?: TrashItem['kind']; sheetId?: string; before?: number; limit?: number } = {},
): TrashList {
  const limit = Math.max(1, Math.min(TRASH_LIST_PAGE, opts.limit ?? TRASH_LIST_PAGE));
  const like = opts.q?.trim() ? `%${opts.q.trim().replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
  const rows = db.prepare(`SELECT * FROM trash_items WHERE user_id = ? AND id < ?
      AND (? IS NULL OR kind = ?) AND (? IS NULL OR sheet_id = ?)
      AND (? IS NULL OR table_name LIKE ? ESCAPE '\\' OR sheet_name LIKE ? ESCAPE '\\'
        OR token_name LIKE ? ESCAPE '\\')
    ORDER BY id DESC LIMIT ?`)
    .all(userId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.kind ?? null, opts.kind ?? null,
      opts.sheetId ?? null, opts.sheetId ?? null, like, like, like, like, limit + 1) as TrashItem[];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const days = getTrashDays(userId);
  const total = db.prepare('SELECT IFNULL(SUM(bytes), 0) FROM trash_items WHERE user_id = ?').pluck()
    .get(userId) as number;
  return {
    items: page.map(i => entryOf(i, days)), kept_days: days,
    next_before: more ? page[page.length - 1].id : null, total_bytes: total,
  };
}

export function getTrashEntry(userId: string, id: number): TrashEntry | null {
  const item = getTrashItem(id, userId);
  return item ? entryOf(item, getTrashDays(userId)) : null;
}

export interface TrashRowsPage {
  trash_id: number; columns: string[];
  // old_row_index: where the row was (the restore puts it back there when it can).
  rows: Array<{ seq: number; row_id: string; old_row_index: number; cells: Record<string, string> }>;
  // Where the next call goes on from (pass it as `after`), or null at the end.
  next_after: number | null;
}

// A batch's rows by seq. With `contains`, only rows whose `column` (or any
// cell, without one) holds the text, ignoring case: each call reads at most
// TRASH_SEARCH_SCAN_ROWS rows, so a search through a big batch takes a few.
export function readTrashRows(
  userId: string, id: number,
  opts: { after?: number; limit?: number; column?: string; contains?: string } = {},
): TrashRowsPage | { fail: 'not_found' | 'bad_request'; message: string } {
  const item = getTrashItem(id, userId);
  if (!item || item.kind !== 'rows') {
    return { fail: 'not_found', message: 'No batch of rows in the trash with that id.' };
  }
  const columns = batchColumns(item);
  if (opts.column && !columns.includes(opts.column)) {
    return { fail: 'bad_request', message: `These rows have no column "${opts.column}".` };
  }
  const limit = Math.max(1, Math.min(TRASH_ROWS_PAGE_MAX, opts.limit ?? TRASH_ROWS_PAGE_DEFAULT));
  const after = opts.after ?? 0;
  const text = opts.contains?.trim() ? opts.contains.trim().toLowerCase() : null;
  let found: Array<{ seq: number; row_index: number; row_id: string; data: string }>;
  let next: number | null;
  if (text === null) {
    found = db.prepare(`SELECT seq, row_index, row_id, data FROM trash_rows WHERE item_id = ? AND seq > ?
      ORDER BY seq LIMIT ?`).all(id, after, limit + 1) as typeof found;
    next = found.length > limit ? found[limit - 1].seq : null;
    found = found.slice(0, limit);
  } else {
    // The window of rows this call reads, then the matches in it.
    const edge = db.prepare(`SELECT seq FROM trash_rows WHERE item_id = ? AND seq > ? ORDER BY seq
      LIMIT 1 OFFSET ?`).pluck().get(id, after, TRASH_SEARCH_SCAN_ROWS - 1) as number | undefined;
    const cell = opts.column ? 'json_extract(data, ?)' : 'data';
    const params = opts.column ? [jsonPath(opts.column)] : [];
    found = db.prepare(`SELECT seq, row_index, row_id, data FROM trash_rows WHERE item_id = ? AND seq > ? AND seq <= ?
      AND instr(lower(${cell}), ?) > 0 ORDER BY seq LIMIT ?`)
      .all(id, after, edge ?? Number.MAX_SAFE_INTEGER, ...params, text, limit) as typeof found;
    next = found.length === limit ? found[limit - 1].seq : (edge ?? null);
  }
  return {
    trash_id: id, columns,
    rows: found.map(r => ({ seq: r.seq, row_id: r.row_id, old_row_index: r.row_index, cells: parseRowData(r.data) })),
    next_after: next,
  };
}
