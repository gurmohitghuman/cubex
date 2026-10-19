// Pausing, resuming and stopping a setup being used on a sheet. Its record
// moves first (the runner then starts nothing new), then the runs of the
// layer working now follow, through the same run controls as the column menu
// (services/run-lifecycle.ts); a run still writing its placeholders is paused
// by the runner's next sweep. Clean and formula fills are free and short: they
// finish. A stopped setup leaves the columns it made, as a stopped run does.
// Resuming with a token without 'secrets' is refused when a step still to run
// (or an auto-run it turns on at the end) reads a saved key; otherwise the
// record stops allowing saved keys, as resuming a run does.
import { db } from '../lib/db';
import { savedKeyRefsInConfig } from '../lib/http-secrets-scan';
import { pauseRun, resumeCapRefusal, resumeRun, cancelRun } from './run-lifecycle';
import { advanceSetupRun } from './setup-runner';
import {
  getSetupRun, loadSetupRun, planOf, setStatus, stepsOf, type SetupRunRow, type SetupRunView, type StepRecord,
} from './setup-run-store';
import type { RunFail } from './run-shared';
import { actorSpendRefusal, spendCapRefusal } from './token-spend';

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
  const r = loadSetupRun(id);
  if (!r || r.user_id !== userId) return { fail: 'not_found', message: 'Setup run not found' };
  const runs = runsOf(stepsOf(r));
  if (action === 'pause') {
    if (r.status !== 'running') return { fail: 'conflict', message: `It isn't running (it's ${r.status}).` };
    setStatus(id, 'paused');
    for (const x of runs) pauseRun(x.kind, x.runId, userId);
  } else if (action === 'resume') {
    if (r.status !== 'paused') return { fail: 'conflict', message: `It isn't paused (it's ${r.status}).` };
    // Its steps spend for the token that applied it; a token at its own cap restarts none of them.
    // Every paused run is checked before any resumes, so a refusal leaves the setup as it was.
    const capped = spendCapRefusal(userId, r.access_token_id) ?? actorSpendRefusal(userId)
      ?? runs.map(x => resumeCapRefusal(x.kind, x.runId, userId)).find(m => m !== null) ?? null;
    if (capped) return { fail: 'forbidden', message: capped };
    if (!hasSecretsScope && r.allow_secrets) {
      const keys = [...new Set(keysAhead(r))];
      if (keys.length) {
        return { fail: 'forbidden', message: `The rest of this setup reads saved keys (${keys.join(', ')}). `
          + 'The access token needs the \'secrets\' scope to resume it.' };
      }
      db.prepare('UPDATE setup_runs SET allow_secrets = 0 WHERE id = ?').run(id);
    }
    // A token without 'secrets' resumes nothing that reads a saved key (run-lifecycle.ts says which).
    for (const x of runs) {
      const out = await resumeRun(x.kind, x.runId, userId, hasSecretsScope && !!r.allow_secrets);
      if ('fail' in out && (out.fail === 'secrets_required' || out.fail === 'spend_cap')) {
        return { fail: 'forbidden', message: out.message };
      }
    }
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
