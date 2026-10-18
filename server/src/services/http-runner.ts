import { db } from '../lib/db';
import { runRows, countRunRows } from '../lib/run-rows';
import { HTTP_DEFAULT_BATCH_SIZE, HTTP_MAX_CONCURRENCY } from '../lib/constants';
import { type HTTPAPIConfig } from '../lib/http-request';
import { redactError } from '../lib/redact';
import { getSheetColumns } from '../lib/sql-helpers';
import { getRunStatusAndGen, shouldNotStartRun, type HTTPRunRow } from './http-runner-status';
import { processHTTPRow } from './http-row';
import { finalizeHTTPRun, failHTTPRun } from './http-runner-finalize';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { processEnrichmentRun } from './enrich-runner';
import { isWaterfallConfig } from '../lib/waterfall/config';
import { processWaterfallRun } from './waterfall-runner';
import { requestRunStamper } from '../lib/run-inputs/stampers';

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
// time, keeps up to batchSize of them out at once, checks DB status for
// pause/cancel before each row starts.
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
    // A waterfall (config.waterfall) walks its steps per row (services/waterfall-runner.ts).
    if (isWaterfallConfig(config)) {
      await processWaterfallRun(run, config, myGeneration, Array.isArray(targetRowIndices) ? targetRowIndices : null);
      await finalizeHTTPRun(run, runId, myGeneration, targetRowIndices);
      return;
    }
    // An enrichment (config.enrichment) calls treg with its own loop: spend
    // limits, the ledger, idempotent resume (services/enrich-runner.ts).
    if (isEnrichmentConfig(config)) {
      await processEnrichmentRun(run, config, myGeneration, Array.isArray(targetRowIndices) ? targetRowIndices : null);
      await finalizeHTTPRun(run, runId, myGeneration, targetRowIndices);
      return;
    }

    const controller = new AbortController();

    // For a rerun, narrow to the requested rows that still exist (a row deleted
    // between route commit and worker start is simply dropped — same guard as
    // processAIRerun). For a first-time run, process every row. Rows stream in
    // pages (lib/run-rows), never the whole sheet at once.
    const targets = Array.isArray(targetRowIndices) ? targetRowIndices : null;

    const rawBatch = typeof config.batchSize === 'number' && Number.isFinite(config.batchSize)
      ? config.batchSize : HTTP_DEFAULT_BATCH_SIZE;
    // Clamp to HTTP_MAX_CONCURRENCY (default 100): most third-party APIs
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

    // Rolling: a row starts as soon as one settles, up to batchSize at once, so a
    // row waiting to retry (lib/http-retry.ts, up to a minute on a Retry-After)
    // holds only its own slot. Batches that waited for their slowest row left
    // every other slot idle meanwhile. A stop is checked before each row starts;
    // rows already out finish (their writes are dropped once the run isn't ours,
    // and a wait to retry ends early), and a resume picks up the rows still ⏳.
    //
    // Progress counts rows PROCESSED, not rows that succeeded: processHTTPRow
    // catches its own errors and writes a ❌ cell, so failures count too. This is
    // intentional and matches the AI runner: the bar reaching 100% with some ❌
    // cells means "all rows attempted". It's written only while the run is still
    // ours: a pause/cancel/resume meanwhile means a newer worker (or none) owns
    // processed_rows, and rows our writes dropped (STOP_SENTINEL) don't count.
    // Each row carries a stamp of the inputs it is sent with (lib/run-inputs).
    const source = runRows(run.sheet_id, run.user_id, masterCol, targets, requestRunStamper(run, config))
      [Symbol.asyncIterator]();
    const out = new Set<Promise<void>>();
    // A full pool waits for one row to settle. One fresh promise per wait, never
    // Promise.race(out): each race hangs a reaction on every row still out, and
    // rows waiting minutes to retry kept hundreds of MB of them alive.
    let slotFreed: (() => void) | null = null;
    const aSlotFrees = () => new Promise<void>(resolve => { slotFreed = resolve; });
    // The sheet's columns, read at most once a second: a cell with no key is an
    // empty value, not an unresolved {{column}} (withSheetColumns).
    let columns: string[] = [];
    let columnsReadAt = 0;
    const sheetColumns = () => {
      if (Date.now() - columnsReadAt >= 1000) {
        columns = getSheetColumns(run.sheet_id, run.user_id, false);
        columnsReadAt = Date.now();
      }
      return columns;
    };
    try {
      for (;;) {
        if (out.size >= batchSize) { await aSlotFrees(); continue; }
        if (shouldStop(runId, myGeneration)) { controller.abort(); break; }
        const next = await source.next();
        if (next.done) break;
        const done: Promise<void> = processHTTPRow(
          runId, next.value, run, config, controller.signal, myGeneration, sheetColumns(),
        )
          .catch(error => { console.error(`HTTP run ${runId} row error:`, redactError(error)); })
          .finally(() => {
            out.delete(done);
            const wake = slotFreed;
            slotFreed = null;
            wake?.();
            // Never rejects: nothing may be waiting on this row yet (a worker
            // thread dies on an unhandled rejection); a resume recounts anyway.
            try {
              if (!shouldStop(runId, myGeneration)) updateProgress.run(++completed, runId);
            } catch (error) { console.error(`HTTP run ${runId} progress error:`, redactError(error)); }
          });
        out.add(done);
      }
    } finally {
      await Promise.allSettled([...out]);
    }

    await finalizeHTTPRun(run, runId, myGeneration, targetRowIndices);
  } catch (error) {
    console.error(`HTTP run ${runId} error:`, redactError(error));
    await failHTTPRun(failedRun, runId, myGeneration, error);
  }
}
