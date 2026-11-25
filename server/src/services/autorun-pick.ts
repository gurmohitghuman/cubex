// Which rows an auto-run takes next, read a page at a time (never the whole
// sheet): first the rows whose inputs were just written (autorun_pending),
// then new rows above the watermark, in row order. A queued row that isn't
// ready (an input still empty, "Only run if" fails) or already ran leaves the
// queue: writing one of its inputs queues it again. The watermark moves past
// every new row looked at, ready or not, and stops at the first row the run
// had no room for. The start re-checks each row inside its transaction.
// With a start delay (migration 072) a row waits until it has gone that long without a change: a waiting row since
// it was last queued (autorun-mark.ts queues it again on each write), a new row since its last write; the watermark
// stops before the first new row too young, so it is looked at again next time.
import { db } from '../lib/db';
import { AUTORUN_SCAN_PAGE } from '../lib/constants';
import { parseRowData } from '../lib/sql-rows';
import { yieldToRequests } from '../lib/slices';
import { asBulkWriter } from '../lib/bulk-slices';
import { candidateVerdict, type CandidatePlan } from '../lib/autorun-rules';
import type { AutorunEntry } from './autorun-entry';

export interface PickedRow { id: string; fromPending: boolean }
export interface Picked { rows: PickedRow[]; watermark: number }

const PENDING_PAGE = 500;
// New rows looked at per sweep: a million-row import is worked through over
// several sweeps instead of one long one.
const NEW_ROWS_PER_SWEEP = 50_000;

// One page of queued rows, read and decided in one transaction (a slice of a
// bulk writer, its WAL copied back on the checkpoint worker's thread: lib/bulk-slices.ts):
// a write that queues a row again after it was read can't be lost to this page's delete.
function pendingPage(e: AutorunEntry, plan: CandidatePlan, after: string, room: number, due: string):
  { taken: string[]; last: string | null } {
  const taken: string[] = [];
  let last: string | null = null;
  const rows = db.prepare(`SELECT p.row_id AS id, r.data AS data, r.sheet_id AS sheet FROM autorun_pending p
    LEFT JOIN rows r ON r.id = p.row_id WHERE p.autorun_id = ? AND p.row_id > ? AND p.created_at <= ?
    ORDER BY p.row_id LIMIT ?`)
    .all(e.id, after, due, PENDING_PAGE) as Array<{ id: string; data: string | null; sheet: string | null }>;
  const forget: string[] = [];
  for (const r of rows) {
    if (taken.length >= room) break;
    last = r.id;
    if (r.data === null || r.sheet !== e.sheet_id) { forget.push(r.id); continue; }
    if (candidateVerdict(parseRowData(r.data), plan, true) === 'take') taken.push(r.id);
    else forget.push(r.id);
  }
  if (forget.length) {
    db.prepare('DELETE FROM autorun_pending WHERE autorun_id = ? AND row_id IN (SELECT value FROM json_each(?))')
      .run(e.id, JSON.stringify(forget));
  }
  return { taken, last };
}

// The latest change a row may have had and be due now, as SQLite writes its times ('YYYY-MM-DD HH:MM:SS', UTC).
const dueBy = (delayS: number): string => db.prepare("SELECT datetime('now', ?)").pluck()
  .get(`-${Math.max(0, delayS)} seconds`) as string;

export async function pickRows(e: AutorunEntry, plan: CandidatePlan, limit: number): Promise<Picked> {
  const taken = new Map<string, boolean>();
  const delay = e.start_delay_s ?? 0;
  const due = dueBy(delay);
  // Most sweeps find nothing queued (or nothing due yet): no writer then.
  if (db.prepare('SELECT 1 FROM autorun_pending WHERE autorun_id = ? AND created_at <= ? LIMIT 1').get(e.id, due)) {
    await asBulkWriter(async w => {
      for (let after = ''; taken.size < limit;) {
        const page = await w.slice(() => pendingPage(e, plan, after, limit - taken.size, due));
        for (const id of page.taken) taken.set(id, true);
        if (page.last === null) break;
        after = page.last;
      }
    });
  }

  let watermark = e.watermark_row_index;
  const scan = db.prepare(`SELECT id, row_index, data, updated_at FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index > ? ORDER BY row_index LIMIT ?`);
  let young = false;
  for (let looked = 0; taken.size < limit && looked < NEW_ROWS_PER_SWEEP && !young;) {
    const rows = scan.all(e.sheet_id, e.user_id, watermark, AUTORUN_SCAN_PAGE) as
      Array<{ id: string; row_index: number; data: string; updated_at: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (taken.size >= limit) break;
      if (delay > 0 && r.updated_at > due) { young = true; break; }
      if (!taken.has(r.id) && candidateVerdict(parseRowData(r.data), plan, false) === 'take') taken.set(r.id, false);
      watermark = r.row_index;
    }
    looked += rows.length;
    await yieldToRequests();
  }
  return { rows: [...taken].map(([id, fromPending]) => ({ id, fromPending })), watermark };
}
