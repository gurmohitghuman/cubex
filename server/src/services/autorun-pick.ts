// Which rows an auto-run takes next, read a page at a time (never the whole
// sheet): first the rows whose inputs were just written (autorun_pending),
// then new rows above the watermark, in row order. A queued row that isn't
// ready (an input still empty, "Only run if" fails) or already ran leaves the
// queue: writing one of its inputs queues it again. The watermark moves past
// every new row looked at, ready or not, and stops at the first row the run
// had no room for. The start re-checks each row inside its transaction.
import { db } from '../lib/db';
import { AUTORUN_SCAN_PAGE } from '../lib/constants';
import { parseRowData } from '../lib/sql-rows';
import { yieldToRequests } from '../lib/slices';
import { candidateVerdict, type CandidatePlan } from '../lib/autorun-rules';
import type { AutorunEntry } from './autorun-entry';

export interface PickedRow { id: string; fromPending: boolean }
export interface Picked { rows: PickedRow[]; watermark: number }

const PENDING_PAGE = 500;
// New rows looked at per sweep: a million-row import is worked through over
// several sweeps instead of one long one.
const NEW_ROWS_PER_SWEEP = 50_000;

// One page of queued rows, read and decided in one transaction: a write that
// queues a row again after it was read can't be lost to this page's delete.
function pendingPage(e: AutorunEntry, plan: CandidatePlan, after: string, room: number):
  { taken: string[]; last: string | null } {
  const taken: string[] = [];
  let last: string | null = null;
  db.transaction(() => {
    const rows = db.prepare(`SELECT p.row_id AS id, r.data AS data, r.sheet_id AS sheet FROM autorun_pending p
      LEFT JOIN rows r ON r.id = p.row_id WHERE p.autorun_id = ? AND p.row_id > ? ORDER BY p.row_id LIMIT ?`)
      .all(e.id, after, PENDING_PAGE) as Array<{ id: string; data: string | null; sheet: string | null }>;
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
  }).immediate();
  return { taken, last };
}

export async function pickRows(e: AutorunEntry, plan: CandidatePlan, limit: number): Promise<Picked> {
  const taken = new Map<string, boolean>();
  for (let after = ''; taken.size < limit;) {
    const page = pendingPage(e, plan, after, limit - taken.size);
    for (const id of page.taken) taken.set(id, true);
    if (page.last === null) break;
    after = page.last;
    await yieldToRequests();
  }

  let watermark = e.watermark_row_index;
  const scan = db.prepare(`SELECT id, row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index LIMIT ?`);
  for (let looked = 0; taken.size < limit && looked < NEW_ROWS_PER_SWEEP;) {
    const rows = scan.all(e.sheet_id, e.user_id, watermark, AUTORUN_SCAN_PAGE) as
      Array<{ id: string; row_index: number; data: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (taken.size >= limit) break;
      if (!taken.has(r.id) && candidateVerdict(parseRowData(r.data), plan, false) === 'take') taken.set(r.id, false);
      watermark = r.row_index;
    }
    looked += rows.length;
    await yieldToRequests();
  }
  return { rows: [...taken].map(([id, fromPending]) => ({ id, fromPending })), watermark };
}
