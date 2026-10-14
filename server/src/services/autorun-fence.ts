// What an auto-run tick asks first (autorun-loop.ts, clean-follow.ts): is
// there anything to look at, and does its watermark still mean what it did.
import { db } from '../lib/db';
import type { AutorunEntry } from './autorun-entry';

const topRow = (e: AutorunEntry): number => db.prepare(
  'SELECT IFNULL(MAX(row_index), -1) FROM rows WHERE sheet_id = ? AND user_id = ?',
).pluck().get(e.sheet_id, e.user_id) as number;

// rescan: a delete, sort, replace or rename asked for a look now. It is
// cleared here, before anything is read, and the start (and the watermark
// update) go through only while it stays clear: one set meanwhile means the
// rows this tick read may have moved, so the next tick looks again.
export function hasWork(e: AutorunEntry): boolean {
  if (e.rescan) db.prepare('UPDATE autorun_columns SET rescan = 0 WHERE id = ?').run(e.id);
  return !!e.rescan || !!db.prepare('SELECT 1 FROM autorun_pending WHERE autorun_id = ? LIMIT 1').get(e.id)
    || topRow(e) > e.watermark_row_index;
}

// Rows can only be re-meant by a sort or a CSV replace, and both move the
// watermark themselves (lib/autorun-mark.ts). If one ever didn't, start over
// from the rows there now: never run old rows by mistake.
export function generationMoved(e: AutorunEntry): boolean {
  const g = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(e.sheet_id, e.user_id) as number | undefined;
  if (g === undefined || g === e.row_generation_seen) return false;
  console.warn(`Auto-run ${e.id}: rows were reordered without moving its watermark; starting from the rows there now.`);
  db.prepare(`UPDATE autorun_columns SET watermark_row_index = ?, row_generation_seen = ?
    WHERE id = ? AND row_generation_seen = ?`).run(topRow(e), g, e.id, e.row_generation_seen);
  return true;
}
