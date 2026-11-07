// Pausing, resuming and stopping a setup being used on a sheet. Its record
// moves first (the runner then starts nothing new), then the runs of the
// layer working now follow, through the same run controls as the column menu
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
import { pauseRun, resumeCapRefusal, resumeModelRefusal, resumeRun, cancelRun } from './run-lifecycle';
import { modelList } from '../lib/ai-model-check';
import { advanceSetupRun } from './setup-runner';
import {
  getSetupRun, loadSetupRun, planOf, setStatus, stepsOf, type SetupRunRow, type SetupRunView, type StepRecord,
} from './setup-run-store';
import type { RunFail } from './run-shared';
import { resumeTokenFor, spendCapRefusal } from './token-spend';
import { setupResumeLimitRefusal } from './ai-run-limit';
import { resumeHeldInputRefusal } from '../lib/http-held-inputs';

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

const runsOf = (steps: StepRecord[]) =>
  steps.filter(s => s.state === 'running' && (s.kind === 'ai' || s.kind === 'http') && s.runId)
    .map(s => ({ kind: s.kind as 'ai' | 'http', runId: s.runId! }));

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
    // An HTTP API step whose request reads a column another run holds would send its ⏳ cells.
    const held = runs.map(x => resumeHeldInputRefusal(x.kind, x.runId, userId)).find(m => m !== null);
    if (held) return { fail: 'conflict', message: held };
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
    // A token without 'secrets' resumes nothing that reads a saved key (run-lifecycle.ts says which).
    for (const x of runs) {
      const out = await resumeRun(x.kind, x.runId, userId, hasSecretsScope && !!r.allow_secrets);
      if ('fail' in out && (out.fail === 'secrets_required' || out.fail === 'spend_cap')) {
        return { fail: 'forbidden', message: out.message };
      }
      if ('fail' in out && out.fail === 'model_gone') return { fail: 'bad_request', message: out.message };
      // A hold that began after the check above: the setup stays paused, as that step's run does.
      if ('fail' in out && out.fail === 'held') return { fail: 'conflict', message: out.message };
    }
    // Its later steps spend for whom it was resumed for; a pause at the cap (setup-runner.ts) said why in
    // error_message, and that ends with the pause.
    db.prepare(`UPDATE setup_runs SET access_token_id = ?, error_message = NULL
      WHERE id = ? AND user_id = ? AND status = 'paused'`).run(owner, id, userId);
    setStatus(id, 'running');
    void advanceSetupRun(id);
  } else {
    if (r.status !== 'running' && r.status !== 'paused') {
      return { fail: 'conflict', message: `It has already ended (it's ${r.status}).` };
    }
    setStatus(id, 'cancelled', 'You stopped it.');
    for (const x of runs) await cancelRun(x.kind, x.runId, userId);
  }
  return { ok: getSetupRun(userId, id)! };
}
