import { db } from '../lib/db';
import { redactSecrets } from '../lib/redact';
import { getRunStatusAndGen, type HTTPRunRow } from './http-runner-status';
import { clearRunPlaceholders, hasUnfinishedRow } from '../lib/run-placeholders';

// Post-loop status transitions for an HTTP run. Split out of http-runner.ts (one
// responsibility per file): the runner owns the batch loop; this owns the
// terminal state machine. Both the success finalize and the catch-failure path
// are compare-and-set on (status='running', generation=ours) so a pause/cancel/
// resume that raced the worker is never stomped. Mirrors ai-runner.finalizeStatus.

// Called after the batch loop finishes normally. Marks the run completed — unless
// a row it was supposed to process is genuinely unfinished, in which case it's
// failed (so a rerun can retry). targetRowIndices scopes the stuck-check to a
// rerun's own rows.
export async function finalizeHTTPRun(
  run: HTTPRunRow,
  runId: string,
  myGeneration: number,
  targetRowIndices: number[] | undefined,
): Promise<void> {
  const cur = getRunStatusAndGen(runId);
  if (cur?.status !== 'running' || cur.generation !== myGeneration) return;

  // Don't declare "completed" if a row this run was supposed to process is
  // GENUINELY unfinished (master cell still '⏳ Processing...' + no http_results
  // row — SKIPPED by an unexpected throw the batch catch swallowed). No master
  // column = legacy run with no placeholder to key on (complete normally).
  // See hasUnfinishedRow for why this is collision-proof + target-aware.
  const masterCol = run.master_column_name;
  const stuck = masterCol ? hasUnfinishedRow({
    resultsTable: 'http_results', runId, sheetId: run.sheet_id, userId: run.user_id,
    placeholderColumn: masterCol, targetRows: targetRowIndices,
  }) : false;

  if (stuck) {
    const failed = db.prepare(
      "UPDATE http_runs SET status = 'failed', error_message = ?, placeholder_work = 'clearing', updated_at = datetime('now') WHERE id = ? AND status = 'running' AND worker_generation = ?",
    ).run('Some rows could not be processed. Re-run to retry them.', runId, myGeneration);
    if (failed.changes > 0) await clearRunPlaceholders('http', runId);
    return;
  }

  // CAS on (status='running', generation=ours): the getRunStatusAndGen read above
  // can go stale before this UPDATE commits. A pause/cancel/resume landing in that
  // window must NOT be stomped back to 'completed' by this (now-superseded)
  // worker. Without the guard, a resumed run's newer generation — or a user's
  // pause — gets silently overwritten.
  db.prepare(
    "UPDATE http_runs SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'running' AND worker_generation = ?",
  ).run(runId, myGeneration);
}

// Called from the runner's outer catch. Marks the run failed — but ONLY if it's
// still actively ours (CAS): a resume that bumped the generation means a new
// worker owns it, AND a same-generation pause/cancel by the user must not be
// clobbered to 'failed'. Clears this run's '⏳ Processing...' placeholders so
// unfinished rows don't stay stuck forever.
export async function failHTTPRun(
  failedRun: HTTPRunRow | undefined,
  runId: string,
  myGeneration: number,
  error: unknown,
): Promise<void> {
  const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
  const failed = db.prepare(
    "UPDATE http_runs SET status = 'failed', error_message = ?, placeholder_work = 'clearing', updated_at = datetime('now') WHERE id = ? AND status = 'running' AND worker_generation = ?",
  ).run(reason, runId, myGeneration);
  // failedRun is set whenever myGeneration left -1, so it's defined when we get here.
  if (failed.changes > 0 && failedRun) await clearRunPlaceholders('http', runId);
}
