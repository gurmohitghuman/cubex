// Using a setup on a sheet, a layer at a time (API process). A step starts
// once every step whose columns it reads has finished: AI columns have no
// auto-run, so nothing else would run them after the columns they read are
// filled. advanceSetupRun starts the current layer's steps, checks the ones
// running, and moves to the next layer when all are done; the sweep (every
// SETUP_SWEEP_MS) calls it for each live record, so a restart picks a chain
// up from the table alone. A run that fails or is cancelled ends the chain;
// rows that failed inside a run don't (they read as empty further on). The
// last layer done, the setup's auto-runs are turned on (not after a test).
import { db } from '../lib/db';
import { SETUP_SWEEP_MS } from '../lib/constants-setups';
import { isBusyMessage, sheetHeld } from '../lib/sheet-busy';
import { getSheetColumns } from '../lib/sql-helpers';
import { mainColumn, type SetupStep } from '../lib/setups/spec';
import { startSetupStep } from './setup-step-start';
import { saveAutorunSettings } from './autorun-settings';
import { cancelRun, pauseRun } from './run-lifecycle';
import {
  loadSetupRun, planOf, saveSteps, setStatus, stepsOf, type SetupRunRow, type StepRecord,
} from './setup-run-store';

// Each kind's own statements, written out (the SQL check reads literal SQL only).
const RUN_STATUS = {
  ai: 'SELECT status, error_message FROM ai_runs WHERE id = ?',
  http: 'SELECT status, error_message FROM http_runs WHERE id = ?',
  clean: 'SELECT fill_status AS status, error_message FROM clean_columns WHERE id = ?',
  formula: 'SELECT fill_status AS status, error_message FROM formula_columns WHERE id = ?',
} as const;
// What a step's start made, made since the setup started (a record kept from
// before, or a run started by hand earlier, isn't it).
const MADE_SINCE = {
  ai: `SELECT id FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ? AND created_at >= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  http: `SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ? AND created_at >= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  clean: `SELECT id FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ? AND created_at >= ?`,
  formula: `SELECT id FROM formula_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ? AND created_at >= ?`,
} as const;

const stateOf = (st: StepRecord) => db.prepare(RUN_STATUS[st.kind!]).get(st.runId ?? st.recordId) as
  { status: string; error_message: string | null } | undefined;

// Where a started step is: 'working', or how it ended.
function progress(st: StepRecord): 'working' | 'done' | 'failed' | 'cancelled' | 'gone' {
  const s = stateOf(st);
  if (!s) return 'gone';
  if (s.status === 'completed' || s.status === 'done') return 'done';
  return s.status === 'failed' || s.status === 'cancelled' ? s.status : 'working';
}

const runError = (st: StepRecord): string | null => stateOf(st)?.error_message ?? null;

// A step marked 'starting' when the server stopped: the run (or record) its
// start made, if it got that far.
function adopt(r: SetupRunRow, step: SetupStep): StepRecord | null {
  const main = mainColumn(step);
  if (!getSheetColumns(r.sheet_id, r.user_id, false).includes(main)) return null;
  const kind = step.kind === 'enrichment' ? 'http' : step.kind;
  const id = db.prepare(MADE_SINCE[kind]).pluck().get(r.sheet_id, r.user_id, main, r.created_at) as
    string | undefined;
  if (!id) return null;
  return kind === 'clean' || kind === 'formula'
    ? { state: 'running', kind, recordId: id } : { state: 'running', kind, runId: id };
}

// A paused setup's runs stay paused: a run still writing its placeholders
// when the pause came couldn't be paused then (run-lifecycle.ts), so each
// sweep tries again until it is, or has ended.
function holdPaused(r: SetupRunRow): void {
  for (const st of stepsOf(r)) {
    if (st.state !== 'running' || (st.kind !== 'ai' && st.kind !== 'http')) continue;
    if (progress(st) === 'working') pauseRun(st.kind, st.runId!, r.user_id);
  }
}

// The test rows' places now (a sort may have moved them since); null: every row.
function rowIndexes(r: SetupRunRow): number[] | null {
  if (!r.target_row_ids) return null;
  const ids = JSON.parse(r.target_row_ids) as string[];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND id IN (${ph})
    ORDER BY row_index`).pluck().all(r.sheet_id, r.user_id, ...ids) as number[];
}

async function finish(r: SetupRunRow, steps: StepRecord[]): Promise<void> {
  const { spec } = planOf(r);
  if (r.auto_run) {
    for (const [i, s] of spec.steps.entries()) {
      if ((s.kind !== 'http' && s.kind !== 'enrichment') || !s.autoRun) continue;
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

const running = new Set<string>();

export async function advanceSetupRun(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    await advance(id);
  } finally {
    running.delete(id);
  }
}

async function advance(id: string): Promise<void> {
  for (;;) {
    const r = loadSetupRun(id);
    if (!r || r.status !== 'running') return;
    const { spec, layers } = planOf(r);
    const steps = stepsOf(r);
    const now = spec.steps.map((_, i) => i).filter(i => layers[i] === r.layer);
    if (now.length === 0) return finish(r, steps);
    let waiting = false;
    for (const i of now) {
      const st = steps[i], step = spec.steps[i], main = mainColumn(step);
      if (st.state === 'starting') steps[i] = adopt(r, step) ?? { state: 'waiting' };
      if (steps[i].state === 'waiting') {
        waiting = true;
        if (sheetHeld(r.sheet_id)) continue; // a fill, sort, import or export: try again next sweep
        // Paused or stopped meanwhile (an earlier start in this layer awaited): start nothing more.
        if (loadSetupRun(id)?.status !== 'running') { saveSteps(id, steps); return; }
        steps[i] = { state: 'starting' };
        saveSteps(id, steps);
        const out = await startSetupStep(r.user_id, r.sheet_id, step,
          { rowIndexes: rowIndexes(r), allowSecrets: !!r.allow_secrets });
        if ('fail' in out) {
          if (isBusyMessage(out.message)) { steps[i] = { state: 'waiting' }; saveSteps(id, steps); continue; }
          steps[i] = { state: 'failed', note: out.message };
          saveSteps(id, steps);
          setStatus(id, 'failed', `"${main}" couldn't start: ${out.message}`);
          return;
        }
        steps[i] = { state: 'running', ...out.ok };
        saveSteps(id, steps);
        // Paused or stopped while the start awaited: the run it started follows.
        const status = loadSetupRun(id)?.status;
        if (status !== 'running') {
          if (out.ok.kind === 'ai' || out.ok.kind === 'http') {
            if (status === 'paused') pauseRun(out.ok.kind, out.ok.runId, r.user_id);
            else await cancelRun(out.ok.kind, out.ok.runId, r.user_id);
          }
          return;
        }
        continue;
      }
      if (steps[i].state !== 'running') continue;
      const p = progress(steps[i]);
      if (p === 'working') { waiting = true; continue; }
      if (p === 'done') { steps[i] = { ...steps[i], state: 'done' }; continue; }
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
