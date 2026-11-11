// What the Trash page, /api/v1/trash and the MCP trash tools do with items:
// restore several at once (each by its kind: trash-restore.ts for rows,
// trash-restore-sheet.ts for a sheet or table, trash-restore-column.ts for a
// column), delete them for good (the app only: trash-purge.ts), and download
// a batch of rows (or a column's cells) as CSV.
import { db } from '../lib/db';
import { yieldToRequests } from '../lib/slices';
import { parseRowData } from '../lib/sql-helpers';
import { escapeCsvCell } from '../lib/csv-safety';
import { csvLine } from '../lib/csv-write';
import { getTrashItem } from '../lib/trash/store';
import { batchColumns } from '../lib/trash/restore-rows';
import { restoreRows, type RestoreFail, type RowsRestored } from './trash-restore';
import { nothingRestarted, restoreSheetItem, startRestored, type SheetRestored } from './trash-restore-sheet';
import { restoreColumn, type ColumnRestoreOpts, type ColumnRestored } from './trash-restore-column';
import { startFills, type FillStart } from './trash-restore-column-finish';
import type { BlockingRun } from './autorun-block';

export interface RestoreResult {
  trash_id: number;
  restored?: RowsRestored | SheetRestored | ColumnRestored;
  error?: string;
  fail?: RestoreFail['fail'];
  busy?: boolean;
  blocking_run?: BlockingRun;
}

// In the order given: a table before its sheets, a sheet before its columns
// and rows (holdersFirst). What the restored sheets start again (their
// lookups and parked fills) waits for the whole request, so no batch of rows
// restored in it is refused as busy. `opts`: who asks (the words of a
// column's dropped references, and whether its HTTP setup keeps saved keys).
export async function restoreFromTrash(
  userId: string, ids: number[], opts: ColumnRestoreOpts = { surface: 'app', hasSecretsScope: true },
): Promise<RestoreResult[]> {
  const out: RestoreResult[] = [];
  const later = nothingRestarted();
  const fills: FillStart[] = [];
  try {
    for (const id of ids) {
      const item = getTrashItem(id, userId);
      if (!item) {
        out.push({ trash_id: id, error: 'Nothing in the trash with that id.', fail: 'not_found' });
        continue;
      }
      const r = item.kind === 'rows' ? await restoreRows(userId, id)
        : item.kind === 'column' ? await restoreColumn(userId, id, { ...opts, later: fills })
          : restoreSheetItem(userId, id, later);
      if ('ok' in r) out.push({ trash_id: id, restored: r.ok });
      else {
        out.push({
          trash_id: id, error: r.message, fail: r.fail,
          ...(r.busy ? { busy: true } : {}),
          ...(r.blockingRun ? { blocking_run: r.blockingRun } : {}),
        });
      }
    }
  } finally {
    startRestored(later);
    startFills(fills);
  }
  return out;
}

// Restores so that what holds something comes first: tables, then sheets;
// then columns and batches of rows, the newest deletion first, as undoing
// them in turn would. Rows deleted before their column hold its cells: the
// column first, and they come back into it (rather than adding a plain
// column of its name, which would send the column back as "<name>
// (restored)"). Rows deleted after it: they first, and its cells find them.
export function holdersFirst(userId: string, ids: number[]): number[] {
  const rank = { table: 0, sheet: 1, column: 2, rows: 2 } as const;
  const kindOf = (id: number) => getTrashItem(id, userId)?.kind ?? 'rows';
  return [...ids].sort((a, b) => rank[kindOf(a)] - rank[kindOf(b)] || (rank[kindOf(a)] === 2 ? b - a : 0));
}

// A batch's rows as CSV (its columns as they were, escaped as every export
// is: lib/csv-safety.ts), a page at a time between requests.
// `begin` gets the file's name before the first chunk is written.
export async function writeTrashCsv(
  userId: string, id: number, write: (chunk: string) => Promise<boolean>, begin: (name: string) => void,
): Promise<{ ok: { rows: number } } | { fail: 'not_found' }> {
  const item = getTrashItem(id, userId);
  if (!item || (item.kind !== 'rows' && item.kind !== 'column')) return { fail: 'not_found' };
  const what = item.kind === 'column' ? `deleted column ${item.column_name}` : 'deleted rows';
  begin(`${item.sheet_name ?? 'Sheet'} - ${what} ${item.deleted_at.slice(0, 10)}`);
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
