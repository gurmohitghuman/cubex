import { db } from './db';
import { HEAVY_SLICE_ROWS } from './constants';
import { runInSlices } from './slices';

// The plan of a physical sort (services/sheet-sort.ts) and the two row moves
// that carry it out. Rows first move to base + new position, above every
// current one, then down to their new position. Neither move can collide with
// UNIQUE(sheet_id, user_id, row_index), in any order, so both visit rows in
// storage (rowid) order: each slice rewrites neighbouring pages instead of
// pages scattered across the table, which is most of the cost on a big sheet.
//
// The plan is journaled in sort_jobs/sort_chunks (migration 004) before any
// row moves, and the job's stage is recorded as each step starts. Every step
// is idempotent, so a restart redoes the step it stopped in.
export type SortStage = 'planning' | 'moving' | 'parking' | 'mapping' | 'shifting';

export interface SortPlan {
  base: number;
  // Parallel, in rowid order: the row, its old position, its new position.
  rowIds: Float64Array;
  oldAt: Float64Array;
  newAt: Uint32Array;
}

// Old position → new position, for the stored results that point at rows by
// position (lib/sort-results.ts): `olds` ascending, `news` parallel to it.
export interface PositionMap { olds: Float64Array; news: Uint32Array }

const CHUNK_ROWS = 50_000;

// `rids` and `positions` list the rows in old row order (positions ascending);
// order[k] is the index (into them) of the row that ends up at position k.
export function buildPlan(
  rids: number[], positions: number[], order: Uint32Array, base: number,
): { plan: SortPlan; positionMap: PositionMap } {
  const n = rids.length;
  const newOf = new Uint32Array(n);
  for (let k = 0; k < n; k++) newOf[order[k]] = k;
  const byRowid = new Uint32Array(n);
  let inRowidOrder = true;
  for (let i = 0; i < n; i++) {
    byRowid[i] = i;
    if (i > 0 && rids[i] < rids[i - 1]) inRowidOrder = false;
  }
  if (!inRowidOrder) byRowid.sort((a, b) => rids[a] - rids[b]);
  const plan: SortPlan = { base, rowIds: new Float64Array(n), oldAt: new Float64Array(n), newAt: new Uint32Array(n) };
  for (let i = 0; i < n; i++) {
    const r = byRowid[i];
    plan.rowIds[i] = rids[r]; plan.oldAt[i] = positions[r]; plan.newAt[i] = newOf[r];
  }
  return { plan, positionMap: { olds: Float64Array.from(positions), news: newOf } };
}

// The same map rebuilt from a journaled plan, after a restart.
export function positionMapOf(plan: SortPlan): PositionMap {
  const byOld = new Uint32Array(plan.oldAt.length);
  for (let i = 0; i < byOld.length; i++) byOld[i] = i;
  byOld.sort((a, b) => plan.oldAt[a] - plan.oldAt[b]);
  const olds = new Float64Array(byOld.length);
  const news = new Uint32Array(byOld.length);
  for (let i = 0; i < byOld.length; i++) { olds[i] = plan.oldAt[byOld[i]]; news[i] = plan.newAt[byOld[i]]; }
  return { olds, news };
}

export async function savePlan(sheetId: string, userId: string, plan: SortPlan): Promise<void> {
  const n = plan.rowIds.length;
  db.prepare("INSERT INTO sort_jobs (sheet_id, user_id, base, row_count, stage) VALUES (?, ?, ?, ?, 'planning')")
    .run(sheetId, userId, plan.base, n);
  const insert = db.prepare('INSERT INTO sort_chunks (sheet_id, chunk, plan) VALUES (?, ?, ?)');
  let i = 0;
  await runInSlices(() => {
    const end = Math.min(n, i + CHUNK_ROWS);
    const triples = new Float64Array((end - i) * 3);
    for (let j = i; j < end; j++) {
      const o = (j - i) * 3;
      triples[o] = plan.rowIds[j]; triples[o + 1] = plan.oldAt[j]; triples[o + 2] = plan.newAt[j];
    }
    insert.run(sheetId, i / CHUNK_ROWS, Buffer.from(triples.buffer));
    i = end;
    return i < n;
  });
  setSortStage(sheetId, 'moving');
}

export function setSortStage(sheetId: string, stage: SortStage): void {
  db.prepare('UPDATE sort_jobs SET stage = ? WHERE sheet_id = ?').run(stage, sheetId);
}

export function sortJobs(): Array<{ sheet_id: string; user_id: string; base: number; row_count: number; stage: SortStage }> {
  return db.prepare('SELECT sheet_id, user_id, base, row_count, stage FROM sort_jobs').all() as
    Array<{ sheet_id: string; user_id: string; base: number; row_count: number; stage: SortStage }>;
}

// The journaled plan of a sort past its 'planning' stage.
export function loadPlan(sheetId: string, base: number, n: number): SortPlan {
  const plan: SortPlan = { base, rowIds: new Float64Array(n), oldAt: new Float64Array(n), newAt: new Uint32Array(n) };
  let i = 0;
  const chunks = db.prepare('SELECT plan FROM sort_chunks WHERE sheet_id = ? ORDER BY chunk').pluck().all(sheetId) as Buffer[];
  for (const blob of chunks) {
    const triples = new Float64Array(new Uint8Array(blob).buffer);
    for (let o = 0; o < triples.length; o += 3, i++) {
      plan.rowIds[i] = triples[o]; plan.oldAt[i] = triples[o + 1]; plan.newAt[i] = triples[o + 2];
    }
  }
  if (i !== n) throw new Error(`Sort plan for sheet ${sheetId} holds ${i} rows, expected ${n}`);
  return plan;
}

export function dropPlan(sheetId: string): void {
  db.prepare('DELETE FROM sort_jobs WHERE sheet_id = ?').run(sheetId); // chunks cascade
}

// Each row to base + its new position.
export async function moveRowsUp(plan: SortPlan): Promise<void> {
  const set = db.prepare('UPDATE rows SET row_index = ? WHERE rowid = ?');
  await eachPlanSlice(plan, i => { set.run(plan.base + plan.newAt[i], plan.rowIds[i]); });
}

// Each row from base + its new position down to it. The guard makes a redo
// skip rows already moved.
export async function moveRowsDown(plan: SortPlan): Promise<void> {
  const shift = db.prepare('UPDATE rows SET row_index = row_index - ? WHERE rowid = ? AND row_index >= ?');
  await eachPlanSlice(plan, i => { shift.run(plan.base, plan.rowIds[i], plan.base); });
}

async function eachPlanSlice(plan: SortPlan, apply: (i: number) => void): Promise<void> {
  const n = plan.rowIds.length;
  let i = 0;
  await runInSlices(() => {
    const end = Math.min(n, i + HEAVY_SLICE_ROWS);
    db.transaction(() => { for (; i < end; i++) apply(i); })();
    return i < n;
  });
}
