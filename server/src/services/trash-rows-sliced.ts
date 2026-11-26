// Rows a request deletes that are too big for one transaction: the grid's delete (up to 10,000 rows a call) and
// delete_rows over REST and MCP (1,000), on rows holding big cells. Rows that fit HEAVY_SLICE_BYTES (half of it
// when they go to the trash: each row is written twice, into the batch and out of the rows) still go in the
// request's one transaction (trash-rows.ts). Bigger ones go with the sheet held (lib/sheet-busy.ts), in slices
// that fit it (lib/slice-bytes.ts), the WAL copied back on the checkpoint worker's thread (lib/bulk-slices.ts).
// Their batch reads 'moving' meanwhile, so restoring it is refused; the last transaction seals it, writes the
// History line and does what the caller's one transaction did after its delete. A failure midway still closes the
// batch on what went, then is the request's error. A restart midway leaves it moving: the boot seals it
// (sealLeftDeletes).
import { db } from '../lib/db';
import { HEAVY_SLICE_BYTES } from '../lib/constants';
import { withinBytes } from '../lib/slice-bytes';
import { oneTransaction } from '../lib/slices';
import { runInCheckpointedSlices } from '../lib/bulk-slices';
import { withSheetBusy } from '../lib/sheet-busy';
import { autorunRowsRemoved } from '../lib/autorun-mark';
import { pickedRows, removeRows, sealBatch, type RowPick } from '../lib/trash/move';
import { trashKeeps } from '../lib/trash/store';
import { closeRowsBatch, logRowsBatch, openRowsBatch, type RowsBatch, type TrashedRows } from './trash-rows';

const WHAT = 'deleting rows';

// What one delete's transaction may hold of the rows: half of HEAVY_SLICE_BYTES into the trash, all of it when
// nothing is kept (the rows' pages zeroed only).
const budgetOf = (kept: boolean): number => (kept ? HEAVY_SLICE_BYTES / 2 : HEAVY_SLICE_BYTES);

// Whether the picked rows fit one transaction (most deletes): a read of their sizes, from each row's header.
export function fitsOneDelete(sheetId: string, userId: string, pick: RowPick): boolean {
  const rows = pickedRows(sheetId, userId, pick);
  return withinBytes(rows.map(r => r[1]), budgetOf(trashKeeps(userId))) === rows.length;
}

export interface SlicedDelete<F> {
  how: 'grid' | 'api';
  // The grid's earlier call's batch (its answer's trash id).
  continueId?: number;
  // In the first transaction, the sheet held: why the delete can't go now (a run started), else null.
  check: () => F | null;
  // In the last transaction: what the caller's one transaction does after a delete (a fence, open tabs told).
  after: () => void;
}

export async function deleteRowsInSlices<F>(
  sheetId: string, userId: string, pick: RowPick, opts: SlicedDelete<F>,
): Promise<{ ok: TrashedRows } | { refused: F } | { busy: string }> {
  return withSheetBusy(sheetId, WHAT, async (reserve): Promise<{ ok: TrashedRows } | { refused: F }> => {
    const start = db.transaction(() => {
      const refused = opts.check();
      if (refused !== null) return { refused };
      const rows = pickedRows(sheetId, userId, pick);
      const batch = rows.length === 0 ? null : openRowsBatch(sheetId, userId, opts.how, opts.continueId);
      if (batch?.earlier) db.prepare("UPDATE trash_items SET state = 'moving' WHERE id = ?").run(batch.item);
      const top = db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ? AND user_id = ?')
        .pluck().get(sheetId, userId) as number | null;
      return { rows, batch, floor: top === null ? 0 : top + 1 };
    }).immediate() as { refused: F } | { rows: Array<[number, number]>; batch: RowsBatch | null; floor: number };
    if ('refused' in start) return start;
    // Rows added while it goes (webhooks, append_rows, the grid's new rows) land above every row it may remove, as
    // a duplicate removal's do: the last transaction's auto-run fence (autorunRowsRemoved) never passes over them.
    reserve(start.floor);
    const { rows, batch } = start;
    const out: TrashedRows = { count: 0, indexes: [], trashId: null };
    if (rows.length === 0) return { ok: out };
    const budget = budgetOf(batch !== null);
    let at = 0;
    try {
      await runInCheckpointedSlices(() => {
        oneTransaction(() => {
          const next = rows.slice(at);
          const n = withinBytes(next.map(r => r[1]), budget);
          const gone = removeRows(sheetId, userId, { rowids: next.slice(0, n).map(r => r[0]) }, batch?.item ?? null);
          out.count += gone.count;
          out.indexes.push(...gone.indexes);
          at += n;
        });
        return at < rows.length;
      });
    } finally {
      db.transaction(() => {
        out.trashId = closeRowsBatch(sheetId, userId, opts.how, batch, out.count);
        autorunRowsRemoved(sheetId, userId);
        opts.after();
      }).immediate();
    }
    return { ok: out };
  });
}

// At boot: a delete a restart cut short left its batch moving. The rows that went stay in it, sealed, with their
// History line (a grid delete's later call: its first call's line, rewritten); one no row went into leaves the
// trash. Open tabs reload, and auto-run's fence follows the rows gone.
export function sealLeftDeletes(): void {
  const left = db.prepare(`SELECT id, sheet_id, user_id, row_count FROM trash_items WHERE kind = 'rows'
    AND state = 'moving' AND how IN ('grid', 'api')`).all() as
    Array<{ id: number; sheet_id: string; user_id: string; row_count: number }>;
  for (const it of left) {
    db.transaction(() => {
      if (it.row_count === 0) {
        db.prepare('DELETE FROM trash_items WHERE id = ?').run(it.id);
        return;
      }
      sealBatch(it.id, it.sheet_id, it.user_id);
      logRowsBatch(it.sheet_id, it.user_id, it.id);
      autorunRowsRemoved(it.sheet_id, it.user_id);
      db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?')
        .run(it.sheet_id, it.user_id);
    }).immediate();
  }
}
