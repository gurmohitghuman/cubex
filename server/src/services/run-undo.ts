// Undoing a run: the cells it wrote go back to what they held before it,
// from its journal (migration 041, lib/run-undo/), a slice at a time as the
// sheet's one heavy operation (lib/sheet-busy.ts), so no run starts and no
// sort, import or edit lands on the sheet meanwhile. A cell changed since the
// run wrote it stays as it is (skipped), and cells of rows or columns deleted
// since are gone. Nothing runs again and nothing is billed: no auto-run is
// told, only clean, formula and lookup columns reading a restored cell follow
// it. The journal is 'undoing' with a cursor while it goes, so a restart goes
// on (resumeRunUndos). The app's column menu, POST /api/v1/{ai,http}-runs/:id/undo
// and MCP undo_run all come here; services/run-undo-view.ts reads what it would do.
import { db } from '../lib/db';
import { UNDO_RETRY_MAX, UNDO_SLICE_ROWS, UNDO_WAIT_ROWS } from '../lib/constants';
import { continueInBackground, stayBusyToFinish, whenSheetFree, withSheetBusy } from '../lib/sheet-busy';
import { runInSlices } from '../lib/slices';
import { countOf, logSheetChange } from '../lib/change-log';
import { undoSlice, type UndoJob } from '../lib/run-undo/restore';
import { bumpDataVersion } from './data-plane-shared';
import {
  journalColumns, journalOf, runOf, runRow, undoRefusal, undoView, type Journal, type RunInfo, type UndoRunKind,
  type UndoView,
} from './run-undo-view';
import { kickUndoDrops } from './run-undo-prune';
import type { RunFail } from './run-shared';

const WHAT = 'undoing a run';

export async function undoRun(userId: string, kind: UndoRunKind, runId: string): Promise<{ ok: UndoView } | RunFail> {
  const run = runOf(kind, runId, userId);
  if (!run) return { fail: 'not_found', message: 'Run not found.' };
  const refused = undoRefusal(run, journalOf(kind, runId, userId), userId);
  if (refused) return { fail: 'conflict', message: refused };
  const outcome = await withSheetBusy(run.sheet_id, WHAT, async (): Promise<{ ok: UndoView } | RunFail> => {
    // Again, now that nothing else can start on the sheet.
    const now = runOf(kind, runId, userId);
    const j = journalOf(kind, runId, userId);
    const why = now ? undoRefusal(now, j, userId, { holdingSheet: true }) : 'Run not found.';
    if (why || !now || !j) return { fail: 'conflict', message: why ?? 'Run not found.' };
    const claimed = db.prepare("UPDATE run_undos SET state = 'undoing', cursor = 0 WHERE id = ? AND state = 'kept'")
      .run(j.id).changes > 0;
    if (!claimed) return { fail: 'conflict', message: 'This run is being undone now.' };
    let job: UndoJob;
    try { job = jobOf(j, now, userId); } catch (error) { putBack(j.id); throw error; }
    if (j.row_count <= UNDO_WAIT_ROWS) await carryOn(job, now);
    else continueInBackground(run.sheet_id, WHAT, () => carryOn(job, now));
    return { ok: undoView(now, journalOf(kind, runId, userId), userId) };
  });
  return 'busy' in outcome && typeof outcome.busy === 'string'
    ? { fail: 'conflict', message: outcome.busy } : outcome as { ok: UndoView } | RunFail;
}

// The journal as an undo reads it. The run's old run_inputs entries come back
// only while its main column keeps that key (a deleted column's key is gone).
function jobOf(j: Journal, run: RunInfo, userId: string): UndoJob {
  const key = j.stamp_path ? /^\$\."(\d+)"$/.exec(j.stamp_path)?.[1] : undefined;
  const live = key !== undefined && !!db.prepare(`SELECT 1 FROM run_input_keys
    WHERE id = ? AND sheet_id = ? AND user_id = ?`).get(Number(key), run.sheet_id, userId);
  return {
    id: j.id, sheetId: run.sheet_id, userId, columns: journalColumns(j), main: run.column,
    stampPath: live ? j.stamp_path : null,
  };
}

// The run can be undone again from the start (cells already back read as
// such then): a claim that couldn't begin, or an undo that kept failing.
function putBack(undoId: number): void {
  db.prepare(`UPDATE run_undos SET state = 'kept', cursor = 0, restored = 0, skipped = 0, gone = 0
    WHERE id = ? AND state = 'undoing'`).run(undoId);
}

// The slices, then the journal is undone (its rows go later: kickUndoDrops),
// open tabs reload and History says it. A failure half-way keeps the sheet
// busy and goes on with backing off (lib/sheet-busy.ts), from the exact
// cursor; after UNDO_RETRY_MAX failures in a row it stops and frees the sheet.
async function carryOn(job: UndoJob, run: RunInfo): Promise<void> {
  try {
    await goOn(job, run);
  } catch (error) {
    console.error(`Undoing run ${run.id} failed (it goes on):`, error);
    let failures = 1;
    stayBusyToFinish(job.sheetId, WHAT, async () => {
      try {
        await goOn(job, run);
      } catch (again) {
        if (++failures < UNDO_RETRY_MAX) throw again;
        console.error(`Undoing run ${run.id} failed ${failures} times; it can be undone again:`, again);
        putBack(job.id);
      }
    });
  }
}

async function goOn(job: UndoJob, run: RunInfo): Promise<void> {
  await runInSlices(() => undoSlice(job, UNDO_SLICE_ROWS));
  db.transaction(() => {
    const n = db.prepare(`UPDATE run_undos SET state = 'undone', undone_at = datetime('now')
      WHERE id = ? AND state = 'undoing' RETURNING restored, skipped, gone`).get(job.id) as
      { restored: number; skipped: number; gone: number } | undefined;
    if (!n) return;
    bumpDataVersion(job.sheetId, job.userId);
    const left = n.skipped ? `; ${countOf(n.skipped, 'cell')} changed since stayed as they were` : '';
    logSheetChange(job.sheetId, job.userId, 'run_undone',
      `Undid the run of "${run.column ?? 'a deleted column'}": ${countOf(n.restored, 'cell')} back${left}`,
      { column: run.column, detail: { run_id: run.id, kind: run.kind, ...n } });
  })();
  kickUndoDrops();
}

// At boot: an undo a restart cut short goes on from its cursor (its sheet in
// the trash too: its rows are still there).
export function resumeRunUndos(): void {
  const going = db.prepare(`SELECT u.id, u.user_id, u.sheet_id, u.run_kind, u.run_id FROM run_undos u
    WHERE u.state = 'undoing'`).all() as Array<{ id: number; user_id: string; sheet_id: string;
    run_kind: UndoRunKind; run_id: string }>;
  for (const u of going) {
    whenSheetFree(u.sheet_id, WHAT, async () => {
      const run = runRow(u.run_kind, u.run_id);
      const j = journalOf(u.run_kind, u.run_id, u.user_id);
      const info: RunInfo = run ?? {
        id: u.run_id, kind: u.run_kind, sheet_id: u.sheet_id, status: 'cancelled', placeholder_work: null,
        column: null, created_at: '',
      };
      if (j) await carryOn(jobOf(j, info, u.user_id), info);
    }).catch(err => console.error(`Undoing run ${u.run_id} failed:`, err));
  }
}
