import { db } from '../lib/db';
import { redactError } from '../lib/redact';
import { runRows, countRunRows } from '../lib/run-rows';
import { shouldNotStartRun, type AIRunRow } from './ai-runner-status';
import { dispatchRows, finalizeStatus, markFailed } from './ai-runner-lifecycle';
import { fetchModels } from '../lib/openrouter';

// Re-exports for backwards compatibility with existing callers (routes/ai.ts).
export type { AIRunRow } from './ai-runner-status';

// AI runs execute inside Sidequest worker threads. Worker threads don't share JS
// context with the main thread, so anything that needs to be observable across
// the worker/API boundary lives in the DB (ai_runs.status, ai_runs.processed_rows,
// ai_results rows). The API process tails those tables over SSE for live progress;
// pause/resume/cancel are pure UPDATEs. Dispatch + lifecycle helpers (the per-row
// loop, finalize/markFailed transitions) live in ai-runner-lifecycle.ts; this
// file holds the two orchestration entry points.
//
// Per-row checkpoint:
//   - Read ai_runs.status before claiming a row.
//   - 'paused' or 'cancelled' → break the loop (caller transitions cleanly).
//   - 'completed' / 'failed' shouldn't be observed mid-run, but if they are
//     (a stale-job retry kicked in), break too.

// Begin processing an AI run. Streams the sheet's unfinished rows (row_index
// order, a page at a time), dispatches them to processRow with configurable concurrency, updates
// progress on every row. Pause/cancel are detected by polling ai_runs.status.
export async function processAIRun(runId: string, expectedGeneration?: number): Promise<void> {
  // Hoisted so the catch block can compare/clean up. myGeneration -1 means
  // "never started"; failedRun stays undefined until we've read the row, so a
  // catch before that point has nothing to clean (and the generation guard
  // treats us as not-the-owner).
  let myGeneration = -1;
  let failedRun: AIRunRow | undefined;
  try {
    const run = db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(runId) as AIRunRow | undefined;
    if (!run || shouldNotStartRun(run.status)) return;
    failedRun = run;
    // Stale-queued-job guard: the job carries the generation it was enqueued
    // for (queue.ts). A pause-while-queued + resume bumps the run past this
    // job — reject so the resume's job is the only live worker. Legacy jobs
    // (pre-stamping) carry undefined and skip the check.
    if (typeof expectedGeneration === 'number' && expectedGeneration !== run.worker_generation) return;

    myGeneration = run.worker_generation;
    // Compare-and-set claim. Between the SELECT above and this write, the user
    // can cancel/pause (or a resume can bump the generation). A bare UPDATE would
    // blindly overwrite that back to 'running' and resurrect a stopped run — a
    // zombie worker that bills + writes after the user stopped it. Claim ONLY
    // from 'pending' (the sole legitimate pre-claim state — start + resume both
    // set 'pending'): guarding on 'pending' also rejects a duplicate/stale job
    // that observed an already-'running' run (running→running would otherwise let
    // a second worker process the same run). If nothing was claimed, exit.
    const claim = db.prepare(
      "UPDATE ai_runs SET status = 'running', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'pending' AND worker_generation = ?",
    ).run(runId, run.user_id, myGeneration);
    if (claim.changes === 0) return;

    const controller = new AbortController();

    const sheet = db.prepare('SELECT 1 FROM sheets WHERE id = ? AND user_id = ?')
      .get(run.sheet_id, run.user_id);
    if (!sheet) throw new Error('Sheet not found');

    // Resume support: the '⏳ Processing...' placeholder is ground truth for
    // "not yet completed". The old prefix-index resume (start at
    // processed_rows) was wrong under concurrency: processed_rows counts
    // completions in FINISH order, so a row whose in-flight call was aborted
    // by the pause could sit BEFORE the resume index (never reprocessed,
    // stuck on ⏳ forever) while completed rows after it were re-billed.
    // Placeholders are written for every target at run start, overwritten by
    // every completed/error row, and cleared only on cancel — so the rows
    // still holding one are exactly the unfinished ones. A cell the user
    // edited over during the pause is deliberately NOT reprocessed.
    // ALWAYS placeholder-driven, NOT gated on processed_rows > 0. run-start seeds
    // a '⏳ Processing...' placeholder on every target row BEFORE enqueue, so the
    // filter is valid on a fresh run too: a first run has placeholders on all
    // target rows (filter keeps all → process all), and a resume has them only on
    // unfinished rows (filter keeps the remainder). The old `processed_rows > 0`
    // gate broke the zero-progress resume case — a run paused before its first
    // completion had processed_rows = 0, skipped the filter, and reprocessed (and
    // re-billed) every row. (Same class as the HTTP rerun resume fix, migration 024.)
    // The rows stream in pages (lib/run-rows), never the whole sheet at once.
    // Progress = rows already past the placeholder stage. 0 on a fresh run (all
    // rows are placeholders); the completed count on a resume.
    const remaining = countRunRows(run.sheet_id, run.user_id, run.column_name, null);
    const startCompleted = Math.max(0, (run.total_rows || remaining) - remaining);
    // Search rows check the model list for whether the model takes a
    // temperature (services/ai-model-call.ts); read it once here, not per row.
    if (run.use_openrouter_web_search) await fetchModels(Date.now());

    await dispatchRows(runId, run, myGeneration, runRows(run.sheet_id, run.user_id, run.column_name, null), startCompleted, controller);
    await finalizeStatus(runId, run, myGeneration);
  } catch (error) {
    console.error(`AI run ${runId} error:`, redactError(error));
    await markFailed(runId, myGeneration, failedRun, error instanceof Error ? error.message : String(error));
  }
}

// Re-run AI for a specific subset of row indices. Used to retry failed/empty rows.
export async function processAIRerun(runId: string, targetRows: number[], expectedGeneration?: number): Promise<void> {
  let myGeneration = -1;
  let failedRun: AIRunRow | undefined;
  try {
    const run = db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(runId) as AIRunRow | undefined;
    if (!run || shouldNotStartRun(run.status)) return;
    failedRun = run;
    // Stale-queued-job guard — see processAIRun.
    if (typeof expectedGeneration === 'number' && expectedGeneration !== run.worker_generation) return;

    myGeneration = run.worker_generation;
    // Compare-and-set claim. Between the SELECT above and this write, the user
    // can cancel/pause (or a resume can bump the generation). A bare UPDATE would
    // blindly overwrite that back to 'running' and resurrect a stopped run — a
    // zombie worker that bills + writes after the user stopped it. Claim ONLY
    // from 'pending' (the sole legitimate pre-claim state — start + resume both
    // set 'pending'): guarding on 'pending' also rejects a duplicate/stale job
    // that observed an already-'running' run (running→running would otherwise let
    // a second worker process the same run). If nothing was claimed, exit.
    const claim = db.prepare(
      "UPDATE ai_runs SET status = 'running', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'pending' AND worker_generation = ?",
    ).run(runId, run.user_id, myGeneration);
    if (claim.changes === 0) return;

    const controller = new AbortController();

    // Only target rows that still exist come back from runRows (a row deleted
    // between enqueue and worker start would otherwise dispatch with empty {}
    // data — a billed call whose result no-op-writes against a missing row).

    // ALWAYS placeholder-driven (NOT gated on processed_rows > 0) — same fix as
    // processAIRun. The rerun route seeds '⏳ Processing...' on every target row
    // before enqueue, so the filter is valid on the first dispatch (all targets
    // match → process all) and on a resume (only unfinished match). The old gate
    // re-billed every target when a rerun was paused before its first completion.
    const remaining = countRunRows(run.sheet_id, run.user_id, run.column_name, targetRows);
    const startCompleted = Math.max(0, (run.total_rows || targetRows.length) - remaining);
    if (run.use_openrouter_web_search) await fetchModels(Date.now()); // see processAIRun

    await dispatchRows(runId, run, myGeneration, runRows(run.sheet_id, run.user_id, run.column_name, targetRows), startCompleted, controller);
    // Scope the stuck-row check to the rerun's targets (subset) — see finalizeStatus.
    await finalizeStatus(runId, run, myGeneration, targetRows);
  } catch (error) {
    console.error(`AI rerun ${runId} error:`, redactError(error));
    await markFailed(runId, myGeneration, failedRun, error instanceof Error ? error.message : String(error));
  }
}
