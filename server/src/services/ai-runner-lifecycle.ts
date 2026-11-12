// Over 200 lines: the shared row loop and the transitions it ends in, kept together.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { redactSecrets, redactError } from '../lib/redact';
import { getOpenRouterClient } from './openrouter';
import { processRow } from './ai-row';
import { aiInputGate } from './run-input-gate';
import { GatedRows } from './run-gated-rows';
import type { RunParked } from '../lib/run-park';
import {
  getRunStatusAndGen, shouldStop,
  type AIRunRow, type SheetRow,
} from './ai-runner-status';
import { clearRunPlaceholders, hasUnfinishedRow } from '../lib/run-placeholders';
import { spendCapRefusal } from './token-spend';
import { RUN_BREAKER_FAILURES } from '../lib/constants';
import { brakeMessage, RunBreaker, type RowOutcome } from '../lib/run-breaker';
import { isBusyLock, isStorageFailure } from '../lib/storage-failure';
import { pauseItself, runHeartbeat, slotWaiter, storageEnd, type LoopEnd } from '../lib/run-pool';
import { webEngineMessage } from '../lib/web-engine-refusal';
import { openSpendGate, type GateAnswer } from './ai-spend-gate';

// Lifecycle + dispatch helpers shared by processAIRun / processAIRerun
// (ai-runner.ts). Split out so the orchestration entry points stay readable and
// each file owns one responsibility: this file is "how a run's rows get
// dispatched and how the run transitions to a terminal state".

// Shared dispatch loop. Used by both processAIRun and processAIRerun — same
// per-row pattern (a pool of `concurrency` rows + shouldStop checks + progress
// update + .finally cleanup). `rows` streams the unfinished rows a page at a
// time (lib/run-rows), so the worker never holds the whole sheet.
// A run done for an access token with a spend cap reads what the token spent
// before each row: at the cap it starts no more rows but lets the ones out
// finish and write (their cost is billed: aborted, it would be lost and billed
// again on resume), and answers 'token_cap' so the runner pauses it. Rows
// failing in a row on the provider's side (lib/run-breaker.ts) end it the same
// way ('provider_errors'), and so does a database that can't be written
// ('storage'): each row is paid before its result is written. A run with its
// own spend limit starts a row only while the row's most fits under it, and
// answers 'spend_limit' when it can't (services/ai-spend-gate.ts); a database
// busy with another writer then only makes the row wait.
// A stop (pause, cancel, a resume taking over) starts no more rows; the calls
// out finish, within their deadline, and count (each is paid: cancelled, what
// it cost would be lost). A full pool beats updated_at while it waits.
export const dispatchRows = async (
  runId: string,
  run: AIRunRow,
  myGeneration: number,
  rows: AsyncIterable<SheetRow>,
  startCompleted: number,
  controller: AbortController,
): Promise<LoopEnd | RunParked | null> => {
  const openai = await getOpenRouterClient(run.user_id);
  // The sheet's columns, read once for the run: a listed column a row holds no
  // value for reads as empty in its prompt (lib/prompt.ts processPromptTemplate).
  // The columns a prompt reads can't be renamed or deleted while it runs.
  const columns = getSheetColumns(run.sheet_id, run.user_id, false);
  const concurrency = run.concurrency || 5;
  const out = new Set<Promise<void>>();
  const pool = slotWaiter();
  const beat = runHeartbeat('ai_runs', runId, myGeneration);
  const breaker = new RunBreaker(RUN_BREAKER_FAILURES);
  let completed = startCompleted;
  // Set from the rows' callbacks, so its type is spelled out (no narrowing to null).
  let end = null as LoopEnd | null;
  // Rows were still waiting to start when the loop stopped (a brake with none left pauses nothing).
  let rowsLeft = false;
  const updateProgress = db.prepare(
    "UPDATE ai_runs SET processed_rows = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  );
  // A database that refuses writes ends the run, whatever else did (nothing more can be saved).
  const ended = (error: unknown) => { if (isStorageFailure(error)) end = storageEnd(error); };
  const gate = await openSpendGate(run, myGeneration, columns);
  // A row waits before it starts and before its spend is admitted, beating, while a column its prompt reads is
  // held by another run; the run's own end stops the wait too (run-input-gate.ts, run-gated-rows.ts).
  const inputs = aiInputGate(run, () => end !== null || shouldStop(runId, myGeneration));
  const pulled = new GatedRows(rows[Symbol.asyncIterator](), inputs);
  // Room for the row under the run's limit; null: a database that can't be written (end is set).
  // Busy with another writer past busy_timeout: the row waits and asks again.
  const admit = (row: SheetRow): GateAnswer | null => {
    try { return gate!.admit(row); } catch (error) {
      if (isBusyLock(error)) return { wait: true };
      if (!isStorageFailure(error)) throw error;
      ended(error);
      return null;
    }
  };
  const beatNow = () => { try { beat(); } catch (error) { ended(error); } };
  const wait = async () => { await pool.settledOrTick(); beatNow(); };

  // A throw from the row stream still waits for the rows already out: the run
  // is marked failed only once none of them can write (an undo checks for that).
  try {
    rowLoop: for (;;) {
      for (;;) {
        if (shouldStop(runId, myGeneration)) break rowLoop;
        if (end) { rowsLeft = await pulled.left(); break rowLoop; }
        if (out.size < concurrency) break;
        await wait();
      }
      const next = await pulled.next({ signal: controller.signal, tick: beatNow });
      if ('done' in next) break;
      if ('park' in next || end) { rowsLeft = true; break; }
      if ('stopped' in next) continue;
      // A row its run's ring of waits fails calls nothing: no spend to admit, and not the provider's failure.
      const row = next.ring ? { ...next.row, refused: next.ring } : next.row;
      if (run.access_token_id && spendCapRefusal(run.user_id, run.access_token_id)) {
        end = { reason: 'token_cap', message: null };
        break;
      }
      // Its own spend limit: wait while only rows out are in the way, pause when spending alone is.
      let held = 0;
      if (gate && !next.ring) {
        let room = admit(row);
        while (room && 'wait' in room) {
          await wait();
          if (shouldStop(runId, myGeneration)) break rowLoop;
          if (end) { rowsLeft = true; break rowLoop; }
          room = admit(row);
        }
        if (!room) break;
        // This row didn't start: rows are left, whatever the reason (a brake's end needs that too).
        if ('pause' in room) {
          end = { reason: room.reason ?? 'spend_limit', message: room.pause };
          rowsLeft = true;
          break;
        }
        held = room.start;
      }

      let settledAs: RowOutcome | null = null;
      const promise: Promise<void> = processRow(runId, row, run, openai, controller.signal, myGeneration, columns)
        .then(processed => {
          const outcome = next.ring && processed.kind === 'failed' ? { ...processed, provider: false } : processed;
          settledAs = outcome;
          breaker.record(outcome);
          const tripped = breaker.tripped;
          if (tripped && !end) end = { reason: 'provider_errors', message: brakeMessage(tripped, false) };
          // The workspace refused the web fetch engine: once, for every row (this one stays waiting).
          if (outcome.kind === 'dropped' && outcome.webEngine !== undefined && !end) {
            end = { reason: 'web_engine', message: webEngineMessage(outcome.webEngine) };
          }
          // Progress counts rows PROCESSED, not rows that succeeded. A row that
          // errored (API 401, etc.) writes a ❌ cell and resolves normally through
          // here — so it IS counted. This matches the HTTP runner, which also
          // counts failures. Don't count or persist progress for rows that
          // finished after a cancel OR after a resume that bumped the generation past ours.
          if (outcome.kind === 'dropped' || shouldStop(runId, myGeneration)) return;
          completed++;
          updateProgress.run(completed, runId, run.user_id);
        })
        // Thrown only by a write that failed (processRow handles ordinary row
        // failures itself): a database that can't be written ends the run.
        .catch(error => {
          if (isStorageFailure(error)) { ended(error); return; }
          console.error(`Error processing row ${row.rowIndex}:`, redactError(error));
        })
        // Its hold goes back once its cost is in the run's usage record (written with the row).
        .finally(() => { gate?.settle(held, settledAs); out.delete(promise); pool.settled(); });
      out.add(promise);
    }
  } finally {
    // The rows still out finish, beating as they go.
    while (out.size > 0) await wait();
    gate?.close();
  }
  // The provider failed the last rows: nothing is left to hold back, so the run ends as usual.
  if (end?.reason === 'provider_errors' && !rowsLeft) return null;
  // Its rows wait for a run that can't go on in a job slot: the run parks (lib/run-park.ts).
  return end ?? (inputs.parked !== null ? { parkMs: inputs.parked } : null);
};

// The run paused itself (the token's spend cap, its own spend limit, its
// provider failing, a database that can't be written, its web fetch engine
// refused: lib/run-pool.ts). A resume of a token_cap pause is refused until the
// cap is raised (run-lifecycle.ts); a spend_limit one goes on with a higher
// limit; the others go on as they are.
export const pauseAt = (runId: string, myGeneration: number, end: LoopEnd): void =>
  pauseItself('ai_runs', runId, myGeneration, end);

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
