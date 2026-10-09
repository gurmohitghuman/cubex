// Auto-run on a column that adds rows to another sheet (a list job). Turning it
// on needs the fields picked (they come from a test's results) and a
// destination that still exists, and must not close a loop: rows it adds there
// can't set off a list auto-run that adds rows back here. A start lays the
// destination and its columns out like a manual start does; a full destination
// pauses it until rows are deleted there.
import { db } from '../lib/db';
import { listOf, type EnrichRunConfig } from '../lib/enrich-run-config';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import type { ListInput } from '../lib/enrich-list-input';
import { planListDest } from './enrich-list-dest';
import { destRoom } from './enrich-list-room';
import { newestRunOf, type AutorunEntry } from './autorun-entry';

const MAX_HOPS = 10;
const NO_FIELDS = 'Pick the fields to keep first: run it on a few rows, then pick them from the results.';
const NO_DEST = 'The sheet for its rows was deleted. Pick another with Edit enrichment.';

// The sheets list auto-runs on `sheetId` add rows to.
function listTargets(sheetId: string, userId: string): string[] {
  const entries = db.prepare(`SELECT status_column FROM autorun_columns
    WHERE sheet_id = ? AND user_id = ? AND enabled = 1`).pluck().all(sheetId, userId) as string[];
  return entries.flatMap(column => {
    const dest = newestRunOf(sheetId, userId, column)?.dest_sheet_id;
    return dest ? [dest] : [];
  });
}

// Why a list column can't auto-run now, or null.
export function autorunListProblem(sheetId: string, userId: string, config: HTTPAPIConfig): string | null {
  const list = listOf(config);
  if (!list) return null;
  if (!list.fields?.length) return NO_FIELDS;
  const destName = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(list.destSheetId, userId) as string | undefined;
  if (destName === undefined) return NO_DEST;
  const seen = new Set<string>();
  let frontier = [list.destSheetId];
  for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
    const next: string[] = [];
    for (const s of frontier) {
      if (s === sheetId) {
        return `Rows it adds to ${destName} would set off auto-run that adds rows back here. `
          + 'Turn that auto-run off first.';
      }
      if (seen.has(s)) continue;
      seen.add(s);
      next.push(...listTargets(s, userId));
    }
    frontier = next;
  }
  return null;
}

export type ListDestPrep =
  | { ok: { destSheetId: string; newColumns: string[] } | null }
  | { pause: { reason: string; message: string } }
  | { retry: true };

// An auto-run start's destination: the newest run's sheet and its columns.
export function autorunListDest(
  e: AutorunEntry, input: ListInput | null, config: EnrichRunConfig, columns: string[],
): ListDestPrep {
  const list = listOf(config);
  if (!list || !input) return { ok: null };
  if (!list.fields?.length) return { pause: { reason: 'setup', message: NO_FIELDS } };
  // The newest run's own sheet (never a new one): gone, it says so. Busy
  // (rows being added there, a sort): the next tick tries again.
  const plan = planListDest(e.user_id, e.sheet_id, input, columns);
  if ('fail' in plan && plan.fail === 'conflict') return { retry: true };
  if ('fail' in plan) return { pause: { reason: 'setup', message: plan.message } };
  if (!plan.ok.sheetId) return { pause: { reason: 'setup', message: NO_DEST } };
  list.destSheetId = plan.ok.sheetId;
  list.fields = plan.ok.fields;
  list.copy = plan.ok.copy;
  return { ok: { destSheetId: plan.ok.sheetId, newColumns: plan.ok.newColumns } };
}

// A 'dest_full' pause lifts once the destination has room for a row again.
export function destHasRoom(e: AutorunEntry): boolean {
  const run = newestRunOf(e.sheet_id, e.user_id, e.status_column);
  if (!run?.dest_sheet_id) return false;
  const room = destRoom(run.dest_sheet_id, e.user_id);
  return !!room && room.room > 0;
}
