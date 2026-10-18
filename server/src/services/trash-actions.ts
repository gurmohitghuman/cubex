// What the Trash page, /api/v1/trash and the MCP trash tools do with items:
// restore several at once (each by its kind: trash-restore.ts for rows,
// trash-restore-sheet.ts for a sheet or table), delete them for good (the
// app only: trash-purge.ts), and download a batch of rows as CSV.
import { db } from '../lib/db';
import { yieldToRequests } from '../lib/slices';
import { parseRowData } from '../lib/sql-helpers';
import { escapeCsvCell } from '../lib/csv-safety';
import { csvLine } from '../lib/csv-write';
import { getTrashItem } from '../lib/trash/store';
import { batchColumns } from '../lib/trash/restore-rows';
import { restoreRows, type RestoreFail, type RowsRestored } from './trash-restore';
import { restoreSheetItem, type SheetRestored } from './trash-restore-sheet';
import type { BlockingRun } from './autorun-block';

export interface RestoreResult {
  trash_id: number;
  restored?: RowsRestored | SheetRestored;
  error?: string;
  fail?: RestoreFail['fail'];
  busy?: boolean;
  blocking_run?: BlockingRun;
}

// In the order given: a table before its sheets, a sheet before its rows.
export async function restoreFromTrash(userId: string, ids: number[]): Promise<RestoreResult[]> {
  const out: RestoreResult[] = [];
  for (const id of ids) {
    const item = getTrashItem(id, userId);
    if (!item) { out.push({ trash_id: id, error: 'Nothing in the trash with that id.', fail: 'not_found' }); continue; }
    const r = item.kind === 'rows' ? await restoreRows(userId, id) : restoreSheetItem(userId, id);
    if ('ok' in r) out.push({ trash_id: id, restored: r.ok });
    else {
      out.push({
        trash_id: id, error: r.message, fail: r.fail,
        ...(r.busy ? { busy: true } : {}),
        ...(r.blockingRun ? { blocking_run: r.blockingRun } : {}),
      });
    }
  }
  return out;
}

// Restores so that what holds something comes first: tables, then sheets, then rows.
export function holdersFirst(userId: string, ids: number[]): number[] {
  const rank = { table: 0, sheet: 1, rows: 2 } as const;
  const kindOf = (id: number) => getTrashItem(id, userId)?.kind ?? 'rows';
  return [...ids].sort((a, b) => rank[kindOf(a)] - rank[kindOf(b)]);
}

// A batch's rows as CSV (its columns as they were, escaped as every export
// is: lib/csv-safety.ts), a page at a time between requests.
// `begin` gets the file's name before the first chunk is written.
export async function writeTrashCsv(
  userId: string, id: number, write: (chunk: string) => Promise<boolean>, begin: (name: string) => void,
): Promise<{ ok: { rows: number } } | { fail: 'not_found' }> {
  const item = getTrashItem(id, userId);
  if (!item || item.kind !== 'rows') return { fail: 'not_found' };
  begin(`${item.sheet_name ?? 'Sheet'} - deleted rows ${item.deleted_at.slice(0, 10)}`);
  const columns = batchColumns(item);
  const page = db.prepare('SELECT seq, data FROM trash_rows WHERE item_id = ? AND seq > ? ORDER BY seq LIMIT 5000');
  let chunk = columns.map(escapeCsvCell).join(',');
  let rows = 0;
  for (let after = 0; ;) {
    const got = page.all(id, after) as Array<{ seq: number; data: string }>;
    for (const r of got) { chunk += '\r\n' + csvLine(columns, parseRowData(r.data)); rows++; }
    if (!(await write(chunk)) || got.length < 5000) break;
    chunk = '';
    after = got[got.length - 1].seq;
    await yieldToRequests();
  }
  return { ok: { rows } };
}
