import { db } from '../lib/db';
import { redactSecrets, redactError } from '../lib/redact';
import { getOpenRouterClient } from './openrouter';
import { processRow } from './ai-row';
import {
  getRunStatusAndGen, shouldStop,
  type AIRunRow, type SheetRow,
} from './ai-runner-status';
import { clearRunPlaceholders, hasUnfinishedRow } from '../lib/run-placeholders';
import { spendCapRefusal } from './token-spend';

// Lifecycle + dispatch helpers shared by processAIRun / processAIRerun
// (ai-runner.ts). Split out so the orchestration entry points stay readable and
// each file owns one responsibility: this file is "how a run's rows get
// dispatched and how the run transitions to a terminal state".

// Shared dispatch loop. Used by both processAIRun and processAIRerun — same
// per-row pattern (semaphore + shouldStop checks + progress update + .finally
// cleanup). `rows` streams the unfinished rows a page at a time (lib/run-rows),
// so the worker never holds the whole sheet.
// A run done for an access token with a spend cap reads what the token spent
// before each row: at the cap it starts no more rows but lets the ones out
// finish and write (their cost is billed: aborted, it would be lost and billed
// again on resume), and answers 'token_cap' so the runner pauses it.
export const dispatchRows = async (
  runId: string,
  run: AIRunRow,
  myGeneration: number,
  rows: AsyncIterable<SheetRow>,
  startCompleted: number,
  controller: AbortController,
): Promise<'token_cap' | null> => {
  const { default: OpenAI } = await import('openai'); void OpenAI; // satisfy ts when we only need the openai instance
  const openai = await getOpenRouterClient(run.user_id);
  const concurrency = run.concurrency || 5;
  const semaphore = new Map<number, Promise<void>>();
  let completed = startCompleted;
  const updateProgress = db.prepare(
    "UPDATE ai_runs SET processed_rows = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  );

  let i = 0;
  let capped = false;
  // A throw from the row stream still waits for the rows already out: the run
  // is marked failed only once none of them can write (an undo checks for that).
  try {
  for await (const row of rows) {
    while (semaphore.size >= concurrency) await Promise.race(semaphore.values());

    if (shouldStop(runId, myGeneration)) { controller.abort(); break; }
    if (run.access_token_id && spendCapRefusal(run.user_id, run.access_token_id)) { capped = true; break; }

    const key = i++;
    const promise = processRow(runId, row, run, openai, controller.signal, myGeneration)
      .then(() => {
        // Progress counts rows PROCESSED, not rows that succeeded. A row that
        // errored (API 401, etc.) writes a ❌ cell and resolves normally through
        // here — so it IS counted. This matches the HTTP runner's per-batch
        // `completed += batch.length` (which over allSettled also counts failures).
        // The .catch below is only for an UNEXPECTED throw out of processRow, not
        // ordinary row failures (those are handled inside processRow).
        // Don't count or persist progress for rows that finished after a cancel
        // OR after a resume that bumped the generation past ours.
        if (shouldStop(runId, myGeneration)) return;
        completed++;
        updateProgress.run(completed, runId, run.user_id);
      })
      .catch(error => { console.error(`Error processing row ${row.rowIndex}:`, redactError(error)); })
      .finally(() => { semaphore.delete(key); });
    semaphore.set(key, promise);
  }
  } finally {
    await Promise.allSettled(semaphore.values());
  }
  return capped ? 'token_cap' : null;
};

// The run's token reached its spend cap: paused (CAS on running + our
// generation, so a person's pause, cancel or resume wins), rows still ⏳. A
// resume is refused until the cap is raised (run-lifecycle.ts).
export const pauseAtTokenCap = (runId: string, myGeneration: number): void => {
  db.prepare(`UPDATE ai_runs SET status = 'paused', pause_reason = 'token_cap', updated_at = datetime('now')
    WHERE id = ? AND status = 'running' AND worker_generation = ?`).run(runId, myGeneration);
};

export const finalizeStatus = async (
  runId: string, run: AIRunRow, myGeneration: number, targetRows?: number[],
): Promise<void> => {
  // Only mark "completed" if the run still belongs to us. A resume bumped past us
  // → don't clobber the new worker's status.
  const cur = getRunStatusAndGen(runId);
  if (cur?.status !== 'running' || cur.generation !== myGeneration) return;

  // Don't declare "completed" if a row this run was supposed to process is GENUINELY
  // unfinished (placeholder still set + no ai_results row — the row was SKIPPED by an
  // unexpected throw the dispatchRows .catch swallowed). Completing then would strand
  // that cell on a spinner forever with no retry path, and the placeholder string
  // leaks into CSV export + AI prompts. See hasUnfinishedRow for why this is
  // collision-proof + target-aware.
  if (hasUnfinishedRow({
    resultsTable: 'ai_results', runId, sheetId: run.sheet_id, userId: run.user_id,
    placeholderColumn: run.column_name, targetRows,
  })) {
    // markFailed clears the surviving placeholders (same as the cancel path) and the
    // failed-run toast tells the user to re-run the affected rows.
    await markFailed(runId, myGeneration, run, 'Some rows could not be processed. Re-run the column to retry them.');
    return;
  }

  // CAS on (status='running', worker_generation=ours): the getRunStatusAndGen read
  // above can go stale before this UPDATE commits. A pause/cancel/resume (or a
  // boot auto-resume bumping the generation) landing in that window must NOT be
  // stomped back to 'completed' by this now-superseded worker. markFailed below
  // already CAS-es this way; finalize must too (mirrors http-runner-finalize.ts).
  db.prepare(
    "UPDATE ai_runs SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'running' AND worker_generation = ?",
  ).run(runId, myGeneration);
};

export const markFailed = async (runId: string, myGeneration: number, run?: AIRunRow, errorMessage?: string): Promise<void> => {
  // Only mark failed if this run is still ACTIVELY ours. Two ways it might not be:
  //  - a resume bumped the generation past us (a new worker owns it), OR
  //  - the user paused/cancelled at OUR generation — a generation-only check would
  //    let an outer-catch failure clobber 'paused'/'cancelled' → 'failed', undoing
  //    the user's action. So we CAS on (status='running', worker_generation=ours):
  //    only a run still running under our generation can be failed.
  const reason = errorMessage ? redactSecrets(errorMessage).slice(0, 500) : null;
  const failed = db.prepare(
    "UPDATE ai_runs SET status = 'failed', error_message = ?, placeholder_work = 'clearing', updated_at = datetime('now') WHERE id = ? AND status = 'running' AND worker_generation = ?",
  ).run(reason, runId, myGeneration);
  // Clear the ⏳ placeholders this run wrote — unfinished rows would otherwise
  // stay stuck "Loading..." forever (matches the cancel path). `run` is
  // undefined only if catch fired before we read it (myGeneration -1 → the CAS
  // above can't match), so a missing row here means nothing to clean.
  if (failed.changes > 0 && run) await clearRunPlaceholders('ai', runId);
};
