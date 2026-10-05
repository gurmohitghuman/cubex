import { db } from '../lib/db';
import { runRows, countRunRows, type RunRow } from '../lib/run-rows';
import { HTTP_DEFAULT_BATCH_SIZE, HTTP_MAX_CONCURRENCY } from '../lib/constants';
import { type HTTPAPIConfig } from '../lib/http-request';
import { redactError } from '../lib/redact';
import { getSheetColumns } from '../lib/sql-helpers';
import { getRunStatusAndGen, shouldNotStartRun, type HTTPRunRow } from './http-runner-status';
import { processHTTPRow } from './http-row';
import { finalizeHTTPRun, failHTTPRun } from './http-runner-finalize';

export type { HTTPRunRow };

// HTTP runs execute inside Sidequest worker threads. Same architecture as ai-runner:
// DB is the source of truth for status (paused/cancelled/running), every row writes to
// http_results / rows / processed_rows, and the API process tails those tables via SSE
// for live progress. The worker thread can't see any in-process Maps.

const shouldStop = (runId: string, capturedGeneration: number): boolean => {
  const cur = getRunStatusAndGen(runId);
  if (cur === null) return true;
  if (cur.status === 'paused' || cur.status === 'cancelled') return true;
  return cur.generation !== capturedGeneration;
};

// Background worker for an HTTP API run. Streams the unfinished rows a page at a
// time, dispatches them in batches, polls DB status between batches for pause/cancel.
//
// targetRowIndices (a rerun) restricts the candidate set to exactly those rows —
// mirrors ai-runner.processAIRerun. A first-time run omits it and processes the
// whole sheet. The placeholder-driven resume filter below applies within the
// candidate set either way, so a paused-and-resumed rerun still picks up only
// its own unfinished rows.
export async function processHTTPRun(
  runId: string,
  expectedGeneration?: number,
  targetRowIndices?: number[],
): Promise<void> {
  // Hoisted so the catch block can compare/clean up (mirrors ai-runner).
  let myGeneration = -1;
  let failedRun: HTTPRunRow | undefined;
  try {
    const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as HTTPRunRow | undefined;
    if (!run || shouldNotStartRun(run.status)) return;
    failedRun = run;
    // Stale-queued-job guard — see ai-runner.processAIRun for the rationale.
    if (typeof expectedGeneration === 'number' && expectedGeneration !== run.worker_generation) return;

    myGeneration = run.worker_generation;

    // Compare-and-set claim — see ai-runner. Claim ONLY from 'pending' (the sole
    // legitimate pre-claim state): a bare UPDATE would overwrite a cancel/pause
    // that landed between the SELECT and here, and claiming from 'running' would
    // let a duplicate/stale job process an already-running run. Exit if not ours.
    // Claim BEFORE parsing config: a malformed config must throw while we own the
    // run (status='running'), so the catch's CAS can mark it failed — parsing
    // before the claim would leave a bad-config run stuck 'pending' forever.
    const claim = db.prepare(
      "UPDATE http_runs SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending' AND worker_generation = ?",
    ).run(runId, myGeneration);
    if (claim.changes === 0) return;

    const config: HTTPAPIConfig = JSON.parse(run.config);

    const controller = new AbortController();

    // For a rerun, narrow to the requested rows that still exist (a row deleted
    // between route commit and worker start is simply dropped — same guard as
    // processAIRerun). For a first-time run, process every row. Rows stream in
    // pages (lib/run-rows), never the whole sheet at once.
    const targets = Array.isArray(targetRowIndices) ? targetRowIndices : null;

    const rawBatch = typeof config.batchSize === 'number' && Number.isFinite(config.batchSize)
      ? config.batchSize : HTTP_DEFAULT_BATCH_SIZE;
    // Clamp to HTTP_MAX_CONCURRENCY (default 20): most third-party APIs
    // rate-limit well below a bigger fan-out, so more mostly buys 429s.
    const batchSize = Math.max(1, Math.min(rawBatch, HTTP_MAX_CONCURRENCY));

    // Resume support — placeholder-driven, mirroring ai-runner. The OLD
    // prefix-index resume (start at processed_rows against a freshly re-loaded
    // row list) was broken: processed_rows counts completions, but rows the
    // user deleted/added while paused shift the list, so the prefix skipped
    // never-processed rows (stuck on '⏳ Processing...' forever) and re-billed
    // tail rows. The master column is the ground truth: run-start writes
    // '⏳ Processing...' to every target, and http-row overwrites it with
    // ✅/⏭️/❌ on completion — so the rows STILL holding the placeholder are
    // exactly the unfinished ones. (No master column = legacy run with no
    // placeholder to key on; fall back to processing everything.)
    // ALWAYS placeholder-driven when a master column exists (NOT gated on
    // processed_rows > 0 — this matches the AI runner's fix). run-start seeds
    // '⏳ Processing...' on every target row BEFORE enqueue, so the filter is
    // valid on a FRESH run too (all rows are placeholders → filter keeps them
    // all). The old `processed_rows > 0` gate had a hole: a run paused mid-FIRST
    // batch, after some rows wrote results but before any per-batch progress
    // commit, still had processed_rows = 0 — so resume skipped the filter and
    // REPROCESSED the completed rows (duplicate outbound calls + duplicate
    // http_results, since there's no unique (run_id,row_index)). No master column
    // = legacy run with no placeholder to key on → process everything.
    const masterCol = run.master_column_name;
    // Progress = rows already past the placeholder stage. 0 on a fresh run (all
    // rows are placeholders); the completed count on a resume. Beats processed_rows
    // (which counts in finish order and races the pause).
    const remaining = countRunRows(run.sheet_id, run.user_id, masterCol, targets);
    let completed = masterCol ? Math.max(0, (run.total_rows || remaining) - remaining) : 0;
    const updateProgress = db.prepare(
      "UPDATE http_runs SET processed_rows = ?, updated_at = datetime('now') WHERE id = ?",
    );

    // Batches of batchSize drawn from the row stream.
    const source = runRows(run.sheet_id, run.user_id, masterCol, targets)[Symbol.asyncIterator]();
    for (let first = true; ; first = false) {
      const batch: RunRow[] = [];
      while (batch.length < batchSize) {
        const next = await source.next();
        if (next.done) break;
        batch.push(next.value);
      }
      if (batch.length === 0) break;
      // Tiny gap between batches so we don't hammer the target API.
      if (!first) await new Promise(resolve => setTimeout(resolve, 100));
      if (shouldStop(runId, myGeneration)) { controller.abort(); break; }

      // The sheet's columns, read once per batch: a cell with no key is an
      // empty value, not an unresolved {{column}} (withSheetColumns).
      const columns = getSheetColumns(run.sheet_id, run.user_id, false);
      const promises = batch.map(row =>
        processHTTPRow(runId, row, run, config, controller.signal, myGeneration, columns),
      );

      try {
        // The batch's rows have already written their results by the time
        // allSettled resolves, so count them BEFORE the stop check — otherwise a
        // pause landing here discards a fully-processed batch's progress (and,
        // pre-placeholder-resume, would re-bill it).
        //
        // Progress counts rows PROCESSED, not rows that succeeded: processHTTPRow
        // catches its own errors, writes a ❌ cell, and resolves, so allSettled sees
        // every row as fulfilled and `+= batch.length` counts failures too. This is
        // intentional and matches the AI runner (a failed AI row likewise counts).
        // The bar reaching 100% with some ❌ cells means "all rows attempted," which
        // is correct — don't switch this to a success-only count or the bar stalls
        // below 100% on any run with failures and reads as hung.
        await Promise.allSettled(promises);
        // Check ownership BEFORE writing progress: a pause/cancel/resume during
        // the batch means we no longer own the run. Writing processed_rows then
        // would clobber a resumed (newer-generation) worker's progress, and would
        // count rows our row-writes intentionally dropped (STOP_SENTINEL). Stop
        // without persisting progress that isn't ours.
        if (shouldStop(runId, myGeneration)) break;
        completed += batch.length;
        updateProgress.run(completed, runId);
      } catch (error) {
        console.error(`Batch processing error for HTTP run ${runId}:`, redactError(error));
      }
    }

    await finalizeHTTPRun(run, runId, myGeneration, targetRowIndices);
  } catch (error) {
    console.error(`HTTP run ${runId} error:`, redactError(error));
    await failHTTPRun(failedRun, runId, myGeneration, error);
  }
}
