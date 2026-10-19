// Using a setup on a sheet, a layer at a time (API process). A step starts
// once every step whose columns it reads has finished: AI columns have no
// auto-run, so nothing else would run them after the columns they read are
// filled. advanceSetupRun starts the current layer's steps, checks the ones
// running, and moves to the next layer when all are done; the sweep (every
// SETUP_SWEEP_MS) calls it for each live record, so a restart picks a chain
// up from the table alone. A step in 'again' mode carries a column the sheet
// has on (setup-step-again.ts): no row left to do is done, a run working on
// it is waited for. A run that fails or is cancelled ends the chain; rows that
// failed inside a run don't (they read as empty further on). The last layer
// done, the setup's auto-runs are turned on (not after a test).
import { db } from '../lib/db';
import { SETUP_SWEEP_MS } from '../lib/constants-setups';
import { isBusyMessage, sheetHeld } from '../lib/sheet-busy';
import { mainColumn, type SetupStep } from '../lib/setups/spec';
import { startSetupStep } from './setup-step-start';
import { startAgainStep } from './setup-step-again';
import { saveAutorunSettings } from './autorun-settings';
import { entryFor } from './autorun-entry';
import { cancelRun, pauseRun } from './run-lifecycle';
import { adopt, holdPaused, progress, rowIndexes, runError } from './setup-step-state';
import {
  loadSetupRun, modesOf, planOf, saveSteps, setStatus, stepsOf, type SetupRunRow, type StepRecord,
} from './setup-run-store';
import { withoutChangeLog } from '../lib/change-log';
import { currentActor, runAs } from '../lib/actor';
import { actorSpendRefusal } from './token-spend';

async function finish(r: SetupRunRow, steps: StepRecord[]): Promise<void> {
  const plan = planOf(r), modes = modesOf(plan);
  if (r.auto_run) {
    for (const [i, s] of plan.spec.steps.entries()) {
      if ((s.kind !== 'http' && s.kind !== 'enrichment') || !s.autoRun) continue;
      // A column carried on keeps an auto-run it has on already, with its own rule and caps.
      if (modes[i] === 'again' && entryFor(r.sheet_id, r.user_id, s.name)?.enabled) continue;
      const out = await saveAutorunSettings(r.user_id, r.sheet_id, {
        column: s.name, enabled: true, where: null, runIf: s.autoRun.runIf,
        dailyCapUsd: s.autoRun.dailyCapUsd, dailyRowCap: s.autoRun.dailyRowCap,
      }, { hasSecretsScope: !!r.allow_secrets });
      if ('fail' in out) steps[i].note = `Auto-run wasn't turned on: ${out.message}`;
    }
  }
  saveSteps(r.id, steps);
  setStatus(r.id, 'done');
}

const waitingAgain = (refill: boolean): StepRecord =>
  (refill ? { state: 'waiting', refill: true } : { state: 'waiting' });

// A step that spends (AI, enrichment) spends for the setup's token, which
// advanceSetupRun runs it as: at that token's spend cap it doesn't start (it
// would write its placeholders across the sheet only to pause). Clean, formula
// and plain HTTP API steps cost nothing here.
const capRefusal = (r: SetupRunRow, step: SetupStep): string | null =>
  (step.kind === 'ai' || step.kind === 'enrichment'
    ? actorSpendRefusal(r.user_id, step.kind === 'enrichment' ? step.maxCostPerRowUsd : null) : null);

// Starts step i (marked 'starting' first, so a restart adopts what it made).
// 'waiting': not this round; 'running' or 'done': it moved on; 'ended': the
// setup failed, or was paused or stopped meanwhile, or paused at its token's
// spend cap (the step still waiting, its running runs paused; resumed once
// the cap is raised, it goes on).
async function startStep(
  r: SetupRunRow, i: number, steps: StepRecord[],
): Promise<'waiting' | 'running' | 'done' | 'ended'> {
  const plan = planOf(r), step = plan.spec.steps[i], main = mainColumn(step);
  const capped = capRefusal(r, step);
  if (capped) {
    saveSteps(r.id, steps);
    if (setStatus(r.id, 'paused', `"${main}" didn't start: ${capped}`)) holdPaused(loadSetupRun(r.id)!);
    return 'ended';
  }
  const refill = !!steps[i].refill;
  steps[i] = refill ? { state: 'starting', refill: true } : { state: 'starting' };
  saveSteps(r.id, steps);
  const opts = { rowIndexes: rowIndexes(r), allowSecrets: !!r.allow_secrets };
  const out = modesOf(plan)[i] === 'again'
    ? await startAgainStep(r.user_id, r.sheet_id, step, { ...opts, autoRun: !!r.auto_run, refill })
    : await startSetupStep(r.user_id, r.sheet_id, step, opts);
  if ('wait' in out || ('fail' in out && isBusyMessage(out.message))) {
    steps[i] = waitingAgain(refill);
    saveSteps(r.id, steps);
    return 'waiting';
  }
  if ('done' in out) {
    steps[i] = { state: 'done', note: out.done };
    saveSteps(r.id, steps);
    return 'done';
  }
  if ('follow' in out) {
    steps[i] = { state: 'running', kind: out.follow.kind, recordId: out.follow.recordId, follow: true };
    saveSteps(r.id, steps);
    return 'running';
  }
  if ('fail' in out) {
    steps[i] = { state: 'failed', note: out.message };
    saveSteps(r.id, steps);
    setStatus(r.id, 'failed', `"${main}" couldn't start: ${out.message}`);
    return 'ended';
  }
  steps[i] = { state: 'running', ...out.ok };
  saveSteps(r.id, steps);
  // Paused or stopped while the start awaited: the run it started follows.
  const status = loadSetupRun(r.id)?.status;
  if (status === 'running') return 'running';
  if (out.ok.kind === 'ai' || out.ok.kind === 'http') {
    if (status === 'paused') pauseRun(out.ok.kind, out.ok.runId, r.user_id);
    else await cancelRun(out.ok.kind, out.ok.runId, r.user_id);
  }
  return 'ended';
}

const running = new Set<string>();

export async function advanceSetupRun(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    // Its steps (columns, runs, auto-run) log nothing of their own: the
    // sheet's change log has "Used the setup" (setup-apply.ts). They spend for
    // the token that applied it, also when the sweep goes on with it.
    const tokenId = db.prepare('SELECT access_token_id FROM setup_runs WHERE id = ?').pluck().get(id) as
      string | null | undefined;
    await runAs({ ...currentActor(), tokenId: tokenId ?? null }, () => withoutChangeLog(() => advance(id)));
  } finally {
    running.delete(id);
  }
}

async function advance(id: string): Promise<void> {
  for (;;) {
    const r = loadSetupRun(id);
    if (!r || r.status !== 'running') return;
    const plan = planOf(r), { spec, layers } = plan, modes = modesOf(plan);
    const steps = stepsOf(r);
    const now = spec.steps.map((_, i) => i).filter(i => layers[i] === r.layer);
    if (now.length === 0) return finish(r, steps);
    let waiting = false;
    for (const i of now) {
      const st = steps[i], step = spec.steps[i], main = mainColumn(step);
      // A run carrying a column on is started again rather than adopted: its column's auto-run makes runs
      // of its own, and a second start is safe (it waits for a run working there, takes only rows not done).
      const rerun = modes[i] === 'again' && step.kind !== 'clean' && step.kind !== 'formula';
      if (st.state === 'starting') steps[i] = (rerun ? null : adopt(r, step)) ?? waitingAgain(!!st.refill);
      if (steps[i].state === 'waiting') {
        // A fill, sort, import or export holds the sheet: try again next sweep.
        if (sheetHeld(r.sheet_id)) { waiting = true; continue; }
        // Paused or stopped meanwhile (an earlier start in this layer awaited): start nothing more.
        if (loadSetupRun(id)?.status !== 'running') { saveSteps(id, steps); return; }
        const moved = await startStep(r, i, steps);
        if (moved === 'ended') return;
        if (moved !== 'done') waiting = true;
        continue;
      }
      if (steps[i].state !== 'running') continue;
      const p = progress(r, steps[i], step);
      if (p === 'working') { waiting = true; continue; }
      if (p === 'done') { steps[i] = { ...steps[i], state: 'done' }; continue; }
      // A column carried on that stopped following its columns meanwhile is filled again.
      if (p === 'stopped') { steps[i] = waitingAgain(true); waiting = true; continue; }
      const why = p === 'gone' ? 'its column was deleted' : p === 'cancelled' ? 'it was stopped'
        : runError(steps[i]) ?? 'it failed';
      steps[i] = { ...steps[i], state: p === 'cancelled' ? 'cancelled' : 'failed', note: why };
      saveSteps(id, steps);
      setStatus(id, p === 'cancelled' ? 'cancelled' : 'failed', `"${main}" didn't finish: ${why}.`);
      return;
    }
    saveSteps(id, steps);
    if (waiting) return;
    db.prepare(`UPDATE setup_runs SET layer = layer + 1, updated_at = datetime('now')
      WHERE id = ? AND status = 'running' AND layer = ?`).run(id, r.layer);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export async function setupSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const live = db.prepare(`SELECT * FROM setup_runs WHERE status IN ('running', 'paused') ORDER BY created_at`)
      .all() as SetupRunRow[];
    for (const r of live) {
      try {
        if (r.status === 'paused') holdPaused(r);
        else await advanceSetupRun(r.id);
      } catch (err) {
        console.error(`Setup run ${r.id} couldn't move on this round:`, err);
      }
    }
  } finally { sweeping = false; }
}

export function startSetupLoop(): void {
  if (timer) return;
  timer = setInterval(() => { void setupSweep(); }, SETUP_SWEEP_MS);
  timer.unref?.();
}
