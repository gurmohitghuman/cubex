// Pausing, resuming and stopping a setup being used on a sheet. Its record
// moves first (the runner then starts nothing new; resumed, the sweep leaves
// its runs to go on), then the runs of the layer working now follow, through
// the same run controls as the column menu
// (services/run-lifecycle.ts); a run still writing its placeholders is paused
// by the runner's next sweep. Clean and formula fills are free and short: they
// finish. A stopped setup leaves the columns it made, as a stopped run does.
// Resuming with a token without 'secrets' is refused when a step still to run
// (or an auto-run it turns on at the end) reads a saved key; otherwise the
// record stops allowing saved keys, as resuming a run does. A step's AI run
// that paused at its spend limit can go on only with a higher one, which a
// setup's resume can't give: resuming is refused until the setup is applied
// again with a higher ceiling (it would otherwise run on past what the limit
// counted, or pause again at once).
import { db } from '../lib/db';
import { savedKeyRefsInConfig } from '../lib/http-secrets-scan';
import {
  pauseRun, resumeCapRefusal, resumeModelRefusal, resumeRun, cancelRun, type ControlOutcome,
} from './run-lifecycle';
import { modelList } from '../lib/ai-model-check';
import { advanceSetupRun } from './setup-runner';
import { holdPaused } from './setup-step-state';
import {
  getSetupRun, loadSetupRun, planOf, setStatus, stepsOf, type SetupRunRow, type SetupRunView, type StepRecord,
} from './setup-run-store';
import type { RunFail } from './run-shared';
import { resumeTokenFor, spendCapRefusal } from './token-spend';
import { setupResumeLimitRefusal } from './ai-run-limit';
import { resumeInputRefusal } from '../lib/run-resume-inputs';

export type SetupRunAction = 'pause' | 'resume' | 'cancel';

// The saved keys the rest of the setup would read: steps not done yet, and the
// auto-runs it turns on when it ends.
function keysAhead(r: SetupRunRow): string[] {
  const steps = stepsOf(r);
  return planOf(r).spec.steps.flatMap((s, i) => (s.kind === 'http'
    && (steps[i].state !== 'done' || (r.auto_run && s.autoRun))
    ? savedKeyRefsInConfig(r.user_id, { method: s.request.method, url: s.request.url, headers: s.request.headers,
      body: s.request.body ?? undefined }) : []));
}

// A run's resume refused, as the setup's resume answers it; null: resumed, or it had ended meanwhile.
function refusal(out: ControlOutcome): RunFail | null {
  if (!('fail' in out)) return null;
  if (out.fail === 'secrets_required' || out.fail === 'spend_cap') return { fail: 'forbidden', message: out.message };
  if (out.fail === 'model_gone' || out.fail === 'bad_request') return { fail: 'bad_request', message: out.message };
  // A hold that began after the checks before it: the setup stays paused, as that step's run does.
  return out.fail === 'held' ? { fail: 'conflict', message: out.message } : null;
}

// A resume refused, or failed (a run's job couldn't be queued): the record as it was (paused, its token and
// message), and the runs resumed before that paused again with it. A pause or stop that came meanwhile stays.
function putBack(r: SetupRunRow): void {
  const back = db.prepare(`UPDATE setup_runs SET status = 'paused', access_token_id = ?, error_message = ?,
    updated_at = datetime('now') WHERE id = ? AND status = 'running'`).run(r.access_token_id, r.error_message, r.id);
  if (back.changes > 0) holdPaused(loadSetupRun(r.id)!);
}

const runsOf = (steps: StepRecord[]) =>
  steps.filter(s => s.state === 'running' && (s.kind === 'ai' || s.kind === 'http') && s.runId)
    .map(s => ({ kind: s.kind as 'ai' | 'http', runId: s.runId! }));

// A stopped setup's runs of the layer working now stop too (a setup call paused too long: setup-call.ts).
export async function cancelStepRuns(r: SetupRunRow): Promise<void> {
  for (const x of runsOf(stepsOf(r))) await cancelRun(x.kind, x.runId, r.user_id);
}

export async function controlSetupRun(
  userId: string, id: string, action: SetupRunAction, hasSecretsScope: boolean,
): Promise<{ ok: SetupRunView } | RunFail> {
  // A resume looks its AI steps' models up in OpenRouter's list, read before any check below.
  const models = action === 'resume' ? await modelList() : null;
  const r = loadSetupRun(id);
  if (!r || r.user_id !== userId) return { fail: 'not_found', message: 'Setup run not found' };
  const runs = runsOf(stepsOf(r));
  if (action === 'pause') {
    if (r.status !== 'running') return { fail: 'conflict', message: `It isn't running (it's ${r.status}).` };
    setStatus(id, 'paused');
    for (const x of runs) pauseRun(x.kind, x.runId, userId);
  } else if (action === 'resume') {
    if (r.status !== 'paused') return { fail: 'conflict', message: `It isn't paused (it's ${r.status}).` };
    // An AI step whose model OpenRouter's list doesn't have would fail every row: refused up front too.
    const gone = runs.map(x => resumeModelRefusal(x.kind, x.runId, userId, models)).find(m => m !== null);
    if (gone) return { fail: 'bad_request', message: gone };
    const atLimit = runs.map(x => (x.kind === 'ai' ? setupResumeLimitRefusal(x.runId, userId) : null))
      .find(m => m !== null);
    if (atLimit) return { fail: 'conflict', message: atLimit };
    // A step reading a column another run holds would send its ⏳ cells; an AI prompt may name a column gone since.
    const held = runs.map(x => resumeInputRefusal(x.kind, x.runId, userId)).find(m => m !== null);
    if (held) return { fail: held.fail === 'held' ? 'conflict' : 'bad_request', message: held.message };
    // Its steps spend for the token that applied it, or for a token that resumes it (it becomes that
    // token's, as each run it resumes does; the app takes a revoked token's over): that token's cap
    // counts. Every paused run is checked before any resumes, so a refusal leaves the setup as it was.
    const owner = resumeTokenFor(userId, r.access_token_id);
    const capped = spendCapRefusal(userId, owner)
      ?? runs.map(x => resumeCapRefusal(x.kind, x.runId, userId)).find(m => m !== null) ?? null;
    if (capped) return { fail: 'forbidden', message: capped };
    if (!hasSecretsScope && r.allow_secrets) {
      const keys = [...new Set(keysAhead(r))];
      if (keys.length) {
        return { fail: 'forbidden', message: `The rest of this setup reads saved keys (${keys.join(', ')}). `
          + 'The access token needs the \'secrets\' scope to resume it.' };
      }
      db.prepare('UPDATE setup_runs SET allow_secrets = 0 WHERE id = ? AND user_id = ?').run(id, userId);
    }
    // The record goes running before any of its runs move: the sweep pauses a paused setup's runs
    // (setup-sweep.ts), so one meanwhile would pause each run just resumed, its job would then run nothing, and
    // the step would wait with no end. Its later steps spend for whom it was resumed for; a pause at the cap
    // (setup-runner.ts) said why in error_message, and that ends with the pause.
    const moved = db.prepare(`UPDATE setup_runs SET status = 'running', access_token_id = ?, error_message = NULL,
      updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'paused'`).run(owner, id, userId);
    if (moved.changes === 0) {
      return { fail: 'conflict', message: `It isn't paused (it's ${loadSetupRun(id)?.status}).` };
    }
    // A token without 'secrets' resumes nothing that reads a saved key (run-lifecycle.ts says which).
    for (const x of runs) {
      // Paused or stopped meanwhile: no more runs resume (the sweep pauses one resumed as the pause came).
      if (loadSetupRun(id)?.status !== 'running') break;
      let out: ControlOutcome;
      try {
        out = await resumeRun(x.kind, x.runId, userId, hasSecretsScope && !!r.allow_secrets);
      } catch (err) {
        // Its job couldn't be queued (that run is paused again): the setup goes back too, then the error.
        putBack(r);
        throw err;
      }
      const refused = refusal(out);
      if (refused) { putBack(r); return refused; }
    }
    void advanceSetupRun(id);
  } else {
    if (r.status !== 'running' && r.status !== 'paused') {
      return { fail: 'conflict', message: `It has already ended (it's ${r.status}).` };
    }
    setStatus(id, 'cancelled', 'You stopped it.');
    await cancelStepRuns(r);
  }
  return { ok: getSetupRun(userId, id)! };
}
