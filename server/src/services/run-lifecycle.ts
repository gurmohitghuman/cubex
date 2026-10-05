// Pause / resume / cancel for AI + HTTP runs — extracted from ai-control.ts and
// http-jobs.ts (identical logic, parameterized by run kind) so the UI routes,
// /api/v1 and the MCP control_run tool share one implementation.
//
// All three are DB status flips; the worker's per-row poll (shouldStop) sees
// the new status and exits cleanly within ~one upstream-call latency.
import { db } from '../lib/db';
import { touchSheet } from '../lib/sql-helpers';
import { clearRunPlaceholders, type RunKind } from '../lib/run-placeholders';
import { parseTargetRows } from '../lib/run-targets';
import { httpRunSecretRefsRequiringScope, httpConfigHasKeyShapedToken } from '../lib/http-secrets-scan';
import { type AIRunRow } from './ai-runner';
import { type HTTPRunRow } from './http-runner';
import { enqueueAIRun, enqueueAIRerun, enqueueHTTPRun, enqueueHTTPRerun } from '../queue';

export type { RunKind };
const TABLE: Record<RunKind, string> = { ai: 'ai_runs', http: 'http_runs' };

export type ControlOutcome =
  | { ok: true }
  | { fail: 'not_found'; message: string }
  | { fail: 'not_active'; message: string }   // pause/cancel target is terminal
  | { fail: 'not_paused'; message: string }   // resume target isn't paused
  | { fail: 'conflict'; message: string }     // resume CAS lost to a cancel
  | { fail: 'secrets_required'; message: string }; // resume would resolve saved keys

const getRun = (kind: RunKind, runId: string, userId: string) =>
  db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as (AIRunRow & HTTPRunRow) | undefined;

export function pauseRun(kind: RunKind, runId: string, userId: string): ControlOutcome {
  const run = getRun(kind, runId, userId);
  if (!run) return { fail: 'not_found', message: 'Run not found' };
  // A run still writing its placeholders isn't queued yet (services/run-seed.ts);
  // a resume would queue it before every target row is marked.
  if (run.placeholder_work === 'seeding') {
    return { fail: 'not_active', message: 'The run is still starting. Pause it in a moment.' };
  }
  const r = db.prepare(
    `UPDATE ${TABLE[kind]} SET status = 'paused', updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND status IN ('pending','running') AND placeholder_work IS NULL`,
  ).run(runId, userId);
  if (r.changes === 0) return { fail: 'not_active', message: `Run is not active (status: ${run.status})` };
  return { ok: true };
}

// hasSecretsScope: whether the CALLER is allowed to resolve saved api_keys.
// Cookie/UI callers (the account owner) pass true; a PAT passes whether its
// token holds 'secrets'. Load-bearing for the secrets gate: resuming an
// existing HTTP run whose stored config references a saved key would have the
// worker inject the decrypted key, so a run-scope-only PAT must be refused
// (the authoring-time scan doesn't cover operating a run you didn't author).
export async function resumeRun(
  kind: RunKind, runId: string, userId: string, hasSecretsScope: boolean,
): Promise<ControlOutcome> {
  const run = getRun(kind, runId, userId);
  if (!run) return { fail: 'not_found', message: 'Run not found' };
  if (run.status !== 'paused') return { fail: 'not_paused', message: `Run is not paused (status: ${run.status})` };

  if (kind === 'http' && !hasSecretsScope && run.allow_secrets !== 0) {
    // A no-'secrets' caller resuming a permissive HTTP run. Two layers:
    //   1. If the config references a saved key that EXISTS now, refuse (403) —
    //      the caller clearly can't be allowed to run it.
    //   2. Otherwise, if the config contains ANY template token that COULD name
    //      a key (a create-key-later TOCTOU: the scan sees no key yet, but the
    //      owner might add one before a later row substitutes), FREEZE the run's
    //      allow_secrets to 0 before resuming. Unlike rerun there's no clone to
    //      freeze, so we flip the stored run — a run a no-secrets caller
    //      operated must never resolve saved keys, now or later.
    const refs = httpRunSecretRefsRequiringScope(userId, run, hasSecretsScope);
    if (refs.length > 0) {
      return {
        fail: 'secrets_required',
        message: `This run references saved API key(s): ${refs.join(', ')}. Resuming it requires the 'secrets' scope.`,
      };
    }
    if (httpConfigHasKeyShapedToken(run.config)) {
      db.prepare(`UPDATE http_runs SET allow_secrets = 0 WHERE id = ? AND user_id = ?`)
        .run(runId, userId);
    }
  }

  // Flip status back to 'pending' AND increment worker_generation BEFORE
  // enqueueing. The generation bump is the race fix: if the previous worker
  // hadn't yet observed 'paused' (mid-API-call), its next per-row check sees
  // the new generation and exits without writing; the new worker captures the
  // bumped generation at startup. Compare-and-set on status='paused': between
  // the SELECT above and here the user can cancel — a bare UPDATE would
  // clobber 'cancelled' back to 'pending' and re-enqueue a killed run.
  const resumed = db.prepare(
    `UPDATE ${TABLE[kind]} SET status = 'pending', worker_generation = worker_generation + 1, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND status = 'paused'`,
  ).run(runId, userId);
  if (resumed.changes === 0) return { fail: 'conflict', message: 'Run is no longer paused' };

  // A rerun targets a row SUBSET (persisted in target_rows, migrations 019/024).
  // Resuming one must re-dispatch the RERUN job — the full-run enqueue would
  // fall back to a whole-sheet run (the placeholder filter only narrows once
  // placeholders differ, and a rerun paused before its first completion still
  // has none consumed).
  const targets = parseTargetRows(run.target_rows);
  try {
    if (kind === 'ai') {
      if (targets) await enqueueAIRerun(runId, targets);
      else await enqueueAIRun(runId);
    } else {
      if (targets) await enqueueHTTPRerun(runId, targets);
      else await enqueueHTTPRun(runId);
    }
  } catch (enqueueError) {
    // Roll the status BACK to 'paused': no job exists, so the run would
    // otherwise sit 'pending' forever — invisible to the worker and
    // un-resumable (this guard requires 'paused'). The bumped
    // worker_generation stays: it only ever needs to differ from what an old
    // worker captured, so a re-resume bumping again stays correct.
    db.prepare(
      `UPDATE ${TABLE[kind]} SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
    ).run(runId, userId);
    throw enqueueError;
  }
  return { ok: true };
}

export async function cancelRun(kind: RunKind, runId: string, userId: string): Promise<ControlOutcome> {
  const run = getRun(kind, runId, userId);
  if (!run) return { fail: 'not_found', message: 'Run not found' };

  // The flip also marks the run's cells for clearing (migration 004), so a
  // restart mid-clear finishes it. A run cancelled while still starting stops
  // seeding at its next slice (services/run-seed.ts).
  const result = db.prepare(
    `UPDATE ${TABLE[kind]} SET status = 'cancelled', placeholder_work = 'clearing', updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND status IN ('pending','running','paused')`,
  ).run(runId, userId);
  if (result.changes === 0) return { fail: 'not_active', message: `Run is not active (status: ${run.status})` };

  // Status flip first, cleanup second: any in-flight row that hasn't hit its
  // shouldStop check drops its write on the next poll, so we never race a
  // real result. Same column resolution as the failed paths
  // (run-placeholders.ts): AI = Output (+ (Data) when web search); HTTP =
  // master/status column + every extracted column for this run. The flip is
  // what stops the run, so the caller gets its answer now; on a big sheet the
  // clear goes on in the background (open grids reload when it's done, and the
  // run counts as active for a sort or a new run on its columns until then).
  // A small sheet's clear has finished before the next request is served.
  clearRunPlaceholders(kind, runId)
    .catch(err => console.error(`Clearing the cells of cancelled ${kind} run ${runId} failed (retried later):`, err));
  touchSheet(run.sheet_id, userId);
  return { ok: true };
}
