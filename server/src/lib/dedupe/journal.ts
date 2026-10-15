// The journal of a duplicate removal (services/dedupe-remove.ts, migration
// 026): the rows to delete, saved before any is deleted, in chunks of
// DEDUPE_DELETE_CHUNK_ROWS rowids. Each chunk is deleted in one transaction together
// with its record, so after a restart the job goes on from the next chunk and
// never deletes one twice.
import { db } from '../db';
import { DEDUPE_DELETE_CHUNK_ROWS } from '../constants-dedupe';
import { runInSlices } from '../slices';

export type DedupeStage = 'planning' | 'deleting';
export interface DedupeJob { sheet_id: string; user_id: string; floor: number; row_count: number; stage: DedupeStage }

// Chunks written per transaction while saving (about 400 KB).
const CHUNKS_PER_SLICE = 200;

// Saves the plan, then marks the job 'deleting'. A failure part-way drops
// what was saved: nothing has been deleted yet.
export async function saveDedupePlan(
  sheetId: string, userId: string, floor: number, rowIds: Float64Array,
): Promise<void> {
  db.prepare("INSERT INTO dedupe_jobs (sheet_id, user_id, floor, row_count, stage) VALUES (?, ?, ?, ?, 'planning')")
    .run(sheetId, userId, floor, rowIds.length);
  const insert = db.prepare('INSERT INTO dedupe_chunks (sheet_id, chunk, plan) VALUES (?, ?, ?)');
  let i = 0, chunk = 0;
  try {
    await runInSlices(() => {
      db.transaction(() => {
        for (let k = 0; k < CHUNKS_PER_SLICE && i < rowIds.length; k++) {
          const end = Math.min(rowIds.length, i + DEDUPE_DELETE_CHUNK_ROWS);
          insert.run(sheetId, chunk++, Buffer.from(rowIds.slice(i, end).buffer));
          i = end;
        }
      })();
      return i < rowIds.length;
    });
    db.prepare("UPDATE dedupe_jobs SET stage = 'deleting' WHERE sheet_id = ?").run(sheetId);
  } catch (error) {
    try { dropDedupeJob(sheetId); } catch { /* boot drops a job still 'planning' */ }
    throw error;
  }
}

// The next chunk still to delete, or null when none is left.
export function nextDedupeChunk(sheetId: string): { chunk: number; rowIds: Float64Array } | null {
  const r = db.prepare('SELECT chunk, plan FROM dedupe_chunks WHERE sheet_id = ? ORDER BY chunk LIMIT 1')
    .get(sheetId) as { chunk: number; plan: Buffer } | undefined;
  return r ? { chunk: r.chunk, rowIds: new Float64Array(new Uint8Array(r.plan).buffer) } : null;
}

export function dropDedupeChunk(sheetId: string, chunk: number): void {
  db.prepare('DELETE FROM dedupe_chunks WHERE sheet_id = ? AND chunk = ?').run(sheetId, chunk);
}

export function dedupeJobs(): DedupeJob[] {
  return db.prepare('SELECT sheet_id, user_id, floor, row_count, stage FROM dedupe_jobs').all() as DedupeJob[];
}

export function dropDedupeJob(sheetId: string): void {
  db.prepare('DELETE FROM dedupe_jobs WHERE sheet_id = ?').run(sheetId); // chunks cascade
}
