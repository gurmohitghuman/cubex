// Auto-run on a column that adds rows to another sheet (a list job). Turning it
// on needs the fields picked (they come from a test's results) and a
// destination that still exists, and must not close a loop: rows it adds there
// can't set off a list auto-run that adds rows back here. A start lays the
// destination and its columns out like a manual start does; a full destination
// pauses it until rows are deleted there.
//
// The loop rule: rows land in a sheet, its list auto-runs add rows to their
// sheets, and so on. Only auto-runs repeat, so a loop needs auto-run on every
// hop, the column's own included: a run started by hand adds rows once, and
// rows coming back only set its column off again while that column auto-runs.
// Paused auto-runs count (a resume can come any time). Checked when auto-run is
// turned on, when a run started by hand points an auto-run column somewhere
// new (enrich-run-prepare.ts), and on every auto-run tick (autorun-loop.ts).
import { db } from '../lib/db';
import { listOf, type EnrichRunConfig } from '../lib/enrich-run-config';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import type { ListInput } from '../lib/enrich-list-input';
import { planListDest } from './enrich-list-dest';
import { destRoom } from './enrich-list-room';
import { entryFor, newestRunOf, type AutorunEntry } from './autorun-entry';
import type { RunFail } from './run-shared';

const NO_FIELDS = 'Pick the fields to keep first: run it on a few rows, then pick them from the results.';
const NO_DEST = 'The sheet for its rows was deleted. Pick another with Edit enrichment.';

const sheetName = (sheetId: string, userId: string): string | undefined => db.prepare(
  'SELECT name FROM sheets WHERE id = ? AND user_id = ?',
).pluck().get(sheetId, userId) as string | undefined;

// The sheets list auto-runs on `sheetId` add rows to, with their columns.
function listTargets(sheetId: string, userId: string): Array<{ column: string; dest: string }> {
  const entries = db.prepare(`SELECT status_column FROM autorun_columns
    WHERE sheet_id = ? AND user_id = ? AND enabled = 1`).pluck().all(sheetId, userId) as string[];
  return entries.flatMap(column => {
    const dest = newestRunOf(sheetId, userId, column)?.dest_sheet_id;
    return dest ? [{ column, dest }] : [];
  });
}

interface LoopCloser { sheet: string; column: string }

// The list auto-run that adds rows back to `sheetId` once rows land in
// `destSheetId` (through any chain of them), or null. Each sheet is looked at
// once, so the walk ends.
function loopCloser(sheetId: string, userId: string, destSheetId: string): LoopCloser | null {
  const seen = new Set([sheetId]);
  let frontier = [destSheetId];
  while (frontier.length) {
    const next: string[] = [];
    for (const s of frontier) {
      if (seen.has(s)) continue;
      seen.add(s);
      for (const t of listTargets(s, userId)) {
        if (t.dest === sheetId) return { sheet: sheetName(s, userId) ?? 'another sheet', column: t.column };
        next.push(t.dest);
      }
    }
    frontier = next;
  }
  return null;
}

const loopWords = (destName: string, c: LoopCloser): string =>
  `Rows it adds to ${destName} would set off auto-run on "${c.column}" in ${c.sheet}, which adds rows back here.`;

// Why a list column can't auto-run now, or null (turning it on).
export function autorunListProblem(sheetId: string, userId: string, config: HTTPAPIConfig): string | null {
  const list = listOf(config);
  if (!list) return null;
  if (!list.fields?.length) return NO_FIELDS;
  const destName = sheetName(list.destSheetId, userId);
  if (destName === undefined) return NO_DEST;
  const closer = loopCloser(sheetId, userId, list.destSheetId);
  return closer ? `${loopWords(destName, closer)} Turn that auto-run off first.` : null;
}

// A tick: the newest run may point somewhere new since auto-run was turned on.
// The pause ('loop') lifts by itself once nothing adds rows back.
export function autorunLoopProblem(e: AutorunEntry): string | null {
  const dest = newestRunOf(e.sheet_id, e.user_id, e.status_column)?.dest_sheet_id;
  if (!dest) return null;
  const closer = loopCloser(e.sheet_id, e.user_id, dest);
  if (!closer) return null;
  const destName = sheetName(dest, e.user_id) ?? 'its sheet';
  return `${loopWords(destName, closer)} Auto-run here goes on once that auto-run is off.`;
}

// A run started by hand on a column with auto-run on, adding rows to
// `destSheetId` (an existing sheet): its auto-run then repeats it, so the
// destination must not lead back here. A column without auto-run adds rows once.
export function manualListLoop(
  sheetId: string, userId: string, column: string, destSheetId: string,
): RunFail | null {
  if (!entryFor(sheetId, userId, column)?.enabled) return null;
  const closer = loopCloser(sheetId, userId, destSheetId);
  if (!closer) return null;
  const destName = sheetName(destSheetId, userId) ?? 'that sheet';
  return {
    fail: 'conflict',
    message: `${loopWords(destName, closer)} This column's auto-run would then add them to ${destName} again, `
      + `without end. Turn off auto-run on "${closer.column}" in ${closer.sheet}, or on this column, first.`,
  };
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
