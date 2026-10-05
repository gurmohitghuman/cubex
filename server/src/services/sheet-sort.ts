// Physical sort — Google Sheets semantics: reorder row_index so the sorted order
// BECOMES the row order, then forget the sort (no live view-sort,
// ever). One implementation for the UI route and /api/v1.
//
// Built for a million rows without freezing the server or holding the sheet in
// memory: sort values are read in slices, ordered by lib/sort-order (a merge sort
// that yields), and rows move in short transactions (lib/slices) in two passes
// (lib/sort-plan): first into a fresh range above every current position, then
// down to 0…n-1. Neither pass can collide with UNIQUE(sheet_id, user_id,
// row_index), and every row stays visible once throughout. The plan is
// journaled first, so a restart finishes the sort (resumeSorts). The sheet is
// busy throughout (lib/sheet-busy): other changes to it are refused, and rows
// appended meanwhile land after the sorted ones.
import { db } from '../lib/db';
import { getSheetColumns, jsonPath, touchSheet } from '../lib/sql-helpers';
import { stayBusyToFinish, whenSheetFree, withSheetBusy } from '../lib/sheet-busy';
import { yieldToRequests } from '../lib/slices';
import { sortedOrder } from '../lib/sort-order';
import {
  buildPlan, dropPlan, loadPlan, moveRowsDown, moveRowsUp, positionMapOf, savePlan, setSortStage, sortJobs,
  type PositionMap, type SortPlan, type SortStage,
} from '../lib/sort-plan';
import { mapResults, parkResults } from '../lib/sort-results';

export type SortOutcome =
  | { ok: true; rowsReordered: number }
  | { fail: 'column_not_found' }
  | { fail: 'active_run' }
  | { fail: 'busy'; error: string };

const READ_SLICE_ROWS = 50_000;

// Caller has already verified sheet ownership. opts.bumpDataVersion: v1 callers
// signal open tabs via the change poll; the UI route keeps its historical
// no-bump behavior.
export async function physicalSortSheet(
  sheetId: string,
  userId: string,
  column: string,
  direction: 'asc' | 'desc',
  opts: { bumpDataVersion?: boolean } = {},
): Promise<SortOutcome> {
  if (!getSheetColumns(sheetId, userId).includes(column)) return { fail: 'column_not_found' };

  // Reordering rewrites row_index — every active runner's write target.
  // Sorting mid-run would scatter results into the wrong rows. (A stopped run
  // still clearing its leftover cells doesn't count: the clear finds them by
  // rowid, which a sort never changes.)
  const activeRun = db.prepare(`
    SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
    UNION SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
    LIMIT 1
  `).get(sheetId, userId, sheetId, userId);
  if (activeRun) return { fail: 'active_run' };

  const outcome = await withSheetBusy(sheetId, 'sorting', async reserve => {
    // A sort an error stopped halfway finishes first, so its rows are back in
    // one piece before they are read again.
    const leftover = sortJobs().find(j => j.sheet_id === sheetId);
    if (leftover) await finishJournaledSort(leftover, reserve);

    // 1. rowid, position and sort value of every row, in row order.
    const rids: number[] = [];
    const positions: number[] = [];
    const values: string[] = [];
    const readSlice = db.prepare(`
      SELECT rowid, row_index, COALESCE(json_extract(data, ?), '') FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?
    `).raw();
    const path = jsonPath(column);
    for (let after = Number.MIN_SAFE_INTEGER; ;) {
      const slice = readSlice.all(path, sheetId, userId, after, READ_SLICE_ROWS) as Array<[number, number, unknown]>;
      for (const [rid, position, v] of slice) { rids.push(rid); positions.push(position); values.push(String(v)); }
      if (slice.length < READ_SLICE_ROWS) break;
      after = slice[slice.length - 1][1];
      await yieldToRequests();
    }
    const n = rids.length;
    if (n === 0) return { ok: true as const, rowsReordered: 0 };

    // 2. The new order: order[k] is the row that ends up at position k.
    const order = await sortedOrder(values, direction);
    values.length = 0;

    // 3. The plan, journaled. base sits above every current position; rows
    // appended from now on land above the whole range the sort will use.
    const { m } = db.prepare('SELECT MAX(row_index) AS m FROM rows WHERE sheet_id = ? AND user_id = ?')
      .get(sheetId, userId) as { m: number };
    const base = m + 1;
    reserve(base + n);
    const { plan, positionMap } = buildPlan(rids, positions, order, base);
    rids.length = 0; positions.length = 0;
    await savePlan(sheetId, userId, plan);

    // 4. Move rows and results.
    await carryOut(sheetId, userId, plan, positionMap, 'moving', opts);
    return { ok: true as const, rowsReordered: n };
  });
  return 'busy' in outcome ? { fail: 'busy', error: outcome.busy } : outcome;
}

const STAGES: SortStage[] = ['moving', 'parking', 'mapping', 'shifting'];

// Carries out a journaled plan from `from` on, then drops the journal. Every
// row_index re-means a different row only now, so the fence moves here: clients
// holding the old row_generation get 409 until they reload, and a tab that
// reloaded mid-sort reloads again. An error midway moves the fence too and
// keeps the sheet busy (its rows are in an in-between order) while the sort is
// retried from its journal in the background (lib/sheet-busy.ts).
async function carryOut(
  sheetId: string, userId: string, plan: SortPlan, positionMap: PositionMap, from: SortStage,
  opts: { bumpDataVersion?: boolean },
): Promise<void> {
  const fence = (bumpDataVersion: boolean) => {
    db.prepare(
      `UPDATE sheets SET row_generation = row_generation + 1${bumpDataVersion ? ', data_version = data_version + 1' : ''}
       WHERE id = ? AND user_id = ?`,
    ).run(sheetId, userId);
  };
  try {
    const at = STAGES.indexOf(from);
    if (at <= 0) { await moveRowsUp(plan); setSortStage(sheetId, 'parking'); }
    if (at <= 1) { await parkResults(sheetId, userId); setSortStage(sheetId, 'mapping'); }
    if (at <= 2) { await mapResults(sheetId, userId, positionMap); setSortStage(sheetId, 'shifting'); }
    await moveRowsDown(plan);
  } catch (error) {
    // Keep the sheet first: the fence write can fail the same way the step
    // did, and a retry's carryOut moves the fence again anyway.
    stayBusyToFinish(sheetId, 'finishing a sort', async () => {
      const job = sortJobs().find(j => j.sheet_id === sheetId);
      if (job) await finishJournaledSort(job, () => {});
    });
    try { fence(true); } catch { /* the retry fences */ }
    throw error;
  }
  db.transaction(() => {
    dropPlan(sheetId);
    fence(!!opts.bumpDataVersion);
    touchSheet(sheetId, userId);
  })();
}

type SortJob = ReturnType<typeof sortJobs>[number];

// Finish (or, before any row moved, forget) a journaled sort.
async function finishJournaledSort(job: SortJob, reserve: (floor: number) => void): Promise<void> {
  if (job.stage === 'planning') { dropPlan(job.sheet_id); return; }
  reserve(job.base + job.row_count);
  const plan = loadPlan(job.sheet_id, job.base, job.row_count);
  await carryOut(job.sheet_id, job.user_id, plan, positionMapOf(plan), job.stage, { bumpDataVersion: true });
}

// At boot: finish every sort a restart interrupted. Call right after the server
// starts listening, before it serves a request: each sheet is marked busy, and
// its append floor reserved, synchronously.
export function resumeSorts(): void {
  for (const job of sortJobs()) {
    whenSheetFree(job.sheet_id, 'finishing a sort', reserve => finishJournaledSort(job, reserve))
      .catch(err => console.error(`Finishing the sort of sheet ${job.sheet_id} failed:`, err));
  }
}
