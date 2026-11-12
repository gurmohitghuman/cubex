// Over 200 lines: pause, resume and cancel for both run kinds, one implementation every surface shares.
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
import { autorunStoppedByUser } from './autorun-stop';
import { logRunControl } from '../lib/change-log';
import { resumeTokenFor, rowCostOf, spendCapRefusal } from './token-spend';
import { diskLow } from '../lib/disk-space';
import { modelGone, modelList, type ModelList } from '../lib/ai-model-check';
import { resumeInputRefusal } from '../lib/run-resume-inputs';
import { waterfallConfigOf } from '../lib/waterfall/config';

export type { RunKind };
const TABLE: Record<RunKind, string> = { ai: 'ai_runs', http: 'http_runs' };

export type ControlOutcome =
  | { ok: true }
  | { fail: 'not_found'; message: string }
  | { fail: 'not_active'; message: string }   // pause/cancel target is terminal
  | { fail: 'not_paused'; message: string }   // resume target isn't paused
  | { fail: 'conflict'; message: string }     // resume CAS lost to a cancel
  | { fail: 'secrets_required'; message: string } // resume would resolve saved keys
  | { fail: 'spend_cap'; message: string }       // resume of a run whose access token is at its spend cap
  | { fail: 'model_gone'; message: string }       // an AI run's model isn't on OpenRouter's list
  | { fail: 'held'; message: string }             // it reads a column another run holds (run-resume-inputs.ts)
  | { fail: 'bad_request'; message: string };     // an AI run's prompt names a column that's gone

const getRun = (kind: RunKind, runId: string, userId: string) =>
  db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as (AIRunRow & HTTPRunRow) | undefined;

const columnOf = (kind: RunKind, run: AIRunRow & HTTPRunRow): string | null =>
  (kind === 'ai' ? run.column_name : run.master_column_name) ?? null;

// Why resuming a paused run would spend past a cap: the cap of the token it
// would spend for from then on (resumeTokenFor). An access token that resumes
// a run makes it its own (the resume below), so only that token's cap counts:
// one at its cap restarts no spending, a run of the app's or another token's
// either; one with room may go on with another token's run, which then spends
// for it. The app resuming keeps the run's token, so a live token's cap
// counts; a revoked token's run the app takes over (no cap). null: it may, or
// the run isn't paused. A setup checks all of its runs before resuming any; a
// resume that changes a run's settings, first.
const capOf = (kind: RunKind, run: AIRunRow & HTTPRunRow, userId: string): string | null =>
  spendCapRefusal(userId, resumeTokenFor(userId, run.access_token_id),
    rowCostOf(kind, kind === 'http' ? run.config : null));
export function resumeCapRefusal(kind: RunKind, runId: string, userId: string): string | null {
  const run = getRun(kind, runId, userId);
  return run && run.status === 'paused' ? capOf(kind, run, userId) : null;
}

// A paused AI run whose model OpenRouter's list doesn't have: resuming it would
// fail every row again (its brake likely paused it for that). `models` comes
// from modelList(), read before the caller's checks. A paused waterfall's AI
// steps, their models frozen when it started, are checked for a ":batch" variant
// (no list is read for an HTTP run), named as its start names a step.
export function resumeModelRefusal(kind: RunKind, runId: string, userId: string, models: ModelList): string | null {
  const run = getRun(kind, runId, userId);
  if (!run || run.status !== 'paused') return null;
  const fix = 'Edit the column to choose another model, then run it again.';
  if (kind === 'ai') return run.model ? modelGone(models, run.model, fix) : null;
  const steps = waterfallConfigOf(run.config)?.waterfall.steps ?? [];
  for (const [n, s] of steps.entries()) {
    const gone = s.on && s.built.kind === 'ai' ? modelGone(null, s.built.model, fix) : null;
    if (gone) return `Step ${n + 1} (${s.label}): ${gone}`;
  }
  return null;
}

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
  logRunControl(run.sheet_id, userId, 'run_paused', columnOf(kind, run), runId);
  return { ok: true };
}

// hasSecretsScope: whether the CALLER is allowed to resolve saved api_keys.
// Cookie/UI callers (the account owner) pass true; a PAT passes whether its
// token holds 'secrets'. Load-bearing for the secrets gate: resuming an
// existing HTTP run whose stored config references a saved key would have the
// worker inject the decrypted key, so a run-scope-only PAT must be refused
// (the authoring-time scan doesn't cover operating a run you didn't author).
// aiSpendLimitUsd: an AI run's new spend limit, and httpBatchSize an HTTP API
// run's new requests at once (its config's batchSize: http-run-resume.ts), each
// written by the update that resumes it, so a resume refused here leaves the old
// one (ai-run-limit.ts).
export async function resumeRun(
  kind: RunKind, runId: string, userId: string, hasSecretsScope: boolean, aiSpendLimitUsd: number | null = null,
  httpBatchSize: number | null = null,
): Promise<ControlOutcome> {
  // An AI run's model is looked up in OpenRouter's list, read before the
  // checks below (nothing between them and the resume may wait).
  const models = kind === 'ai' ? await modelList() : null;
  const run = getRun(kind, runId, userId);
  if (!run) return { fail: 'not_found', message: 'Run not found' };
  if (run.status !== 'paused') return { fail: 'not_paused', message: `Run is not paused (status: ${run.status})` };
  const gone = resumeModelRefusal(kind, runId, userId, models);
  if (gone) return { fail: 'model_gone', message: gone };
  // Paused because results couldn't be saved: each row would be paid for again and lost.
  if ((run as { pause_reason?: string | null }).pause_reason === 'storage' && diskLow()) {
    return { fail: 'conflict', message: "The disk is still nearly full. Free some space, then resume the run." };
  }
  // The run spends for the token that resumes it, or (the app resuming) the one it spent for until now.
  const capped = capOf(kind, run, userId);
  if (capped) return { fail: 'spend_cap', message: capped };
  // It would send another run's ⏳ cells, or an AI prompt a column that's gone (lib/run-resume-inputs.ts).
  const inputs = resumeInputRefusal(kind, runId, userId);
  if (inputs) return inputs;

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
  // A run's pause reason (migrations 011 and 042) ends with the pause, and so
  // does the message a run that paused itself left (lib/run-pool.ts). An
  // access token resuming it makes it its own (the app, a revoked token's):
  // what it spends from now on counts against that token, and so do the calls
  // still out from before when they come back (its usage record follows,
  // migration 045).
  const token = resumeTokenFor(userId, run.access_token_id);
  const resumed = kind === 'http'
    ? db.prepare(`UPDATE http_runs SET status = 'pending', worker_generation = worker_generation + 1,
         updated_at = datetime('now'), pause_reason = NULL, error_message = NULL, access_token_id = ?,
         config = CASE WHEN ? IS NULL THEN config ELSE json_set(config, '$.batchSize', CAST(? AS INTEGER)) END
       WHERE id = ? AND user_id = ? AND status = 'paused'`).run(token, httpBatchSize, httpBatchSize, runId, userId)
    : db.prepare(`UPDATE ai_runs SET status = 'pending', worker_generation = worker_generation + 1,
         updated_at = datetime('now'), pause_reason = NULL, error_message = NULL, access_token_id = ?,
         spend_limit_usd = IFNULL(?, spend_limit_usd)
       WHERE id = ? AND user_id = ? AND status = 'paused'`).run(token, aiSpendLimitUsd, runId, userId);
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
  logRunControl(run.sheet_id, userId, 'run_resumed', columnOf(kind, run), runId);
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
  // Stopping an auto-run run pauses that column's auto-run, so its rows aren't picked up again.
  if (kind === 'http') autorunStoppedByUser(run);

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
  logRunControl(run.sheet_id, userId, 'run_stopped', columnOf(kind, run), runId);
  return { ok: true };
}
