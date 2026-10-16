// The records of setups being used on sheets (setup_runs, migration 028):
// creating one, reading and writing its steps, and the view the app, /api/v1
// and MCP show. The runner (setup-runner.ts) moves them along.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { mainColumn, type SetupSpec, type StepKind } from '../lib/setups/spec';

export type StepState = 'waiting' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
export interface StepRecord {
  state: StepState;
  kind?: 'ai' | 'http' | 'clean' | 'formula'; // what it started: a run's table, or a clean/formula record
  runId?: string;
  recordId?: string;
  note?: string; // why it failed, or what didn't happen after (auto-run not turned on)
}
export type SetupRunStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface SetupRunRow {
  id: string; user_id: string; sheet_id: string; setup_id: string | null; setup_name: string;
  plan: string; steps: string; target_row_ids: string | null; allow_secrets: number; auto_run: number;
  layer: number; status: SetupRunStatus; error_message: string | null; created_at: string; updated_at: string;
}
export interface SetupRunPlan { spec: SetupSpec; layers: number[] }

export interface SetupRunView {
  id: string; setup_id: string | null; setup_name: string; sheet_id: string; status: SetupRunStatus;
  // The layer working now (1-based) of how many; steps in a layer run side by side.
  layer: number; layers: number;
  test_rows: number | null; error_message: string | null; created_at: string; updated_at: string;
  steps: Array<{
    column: string; kind: StepKind; layer: number; state: StepState; run_id: string | null; note: string | null;
  }>;
}

export const loadSetupRun = (id: string): SetupRunRow | undefined =>
  db.prepare('SELECT * FROM setup_runs WHERE id = ?').get(id) as SetupRunRow | undefined;

export const planOf = (r: SetupRunRow): SetupRunPlan => JSON.parse(r.plan);
export const stepsOf = (r: SetupRunRow): StepRecord[] => JSON.parse(r.steps);

export function saveSteps(id: string, steps: StepRecord[]): void {
  db.prepare(`UPDATE setup_runs SET steps = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(steps), id);
}

// Moves a live record on; false when it was no longer live (stopped meanwhile).
export function setStatus(id: string, status: SetupRunStatus, message: string | null = null): boolean {
  return db.prepare(`UPDATE setup_runs SET status = ?, error_message = COALESCE(?, error_message),
    updated_at = datetime('now') WHERE id = ? AND status IN ('running', 'paused')`)
    .run(status, message, id).changes > 0;
}

export function insertSetupRun(p: {
  userId: string; sheetId: string; setupId: string; setupName: string; plan: SetupRunPlan;
  targetRowIds: string[] | null; allowSecrets: boolean; autoRun: boolean;
}): string {
  const id = uuidv4();
  const steps: StepRecord[] = p.plan.spec.steps.map(() => ({ state: 'waiting' }));
  db.transaction(() => {
    db.prepare(`INSERT INTO setup_runs (id, user_id, sheet_id, setup_id, setup_name, plan, steps, target_row_ids,
      allow_secrets, auto_run) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, p.userId, p.sheetId, p.setupId, p.setupName, JSON.stringify(p.plan), JSON.stringify(steps),
      p.targetRowIds ? JSON.stringify(p.targetRowIds) : null, p.allowSecrets ? 1 : 0, p.autoRun ? 1 : 0);
    db.prepare(`UPDATE setups SET use_count = use_count + 1, last_used_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(p.setupId, p.userId);
  })();
  return id;
}

export function setupRunView(r: SetupRunRow): SetupRunView {
  const plan = planOf(r), steps = stepsOf(r);
  const layers = plan.layers.length ? Math.max(...plan.layers) + 1 : 0;
  return {
    id: r.id, setup_id: r.setup_id, setup_name: r.setup_name, sheet_id: r.sheet_id, status: r.status,
    layer: Math.min(r.layer + 1, layers), layers,
    test_rows: r.target_row_ids ? (JSON.parse(r.target_row_ids) as string[]).length : null,
    error_message: r.error_message, created_at: r.created_at, updated_at: r.updated_at,
    steps: plan.spec.steps.map((s, i) => ({
      column: mainColumn(s), kind: s.kind, layer: plan.layers[i] + 1, state: steps[i].state,
      run_id: steps[i].runId ?? null, note: steps[i].note ?? null,
    })),
  };
}

export function getSetupRun(userId: string, id: string): SetupRunView | null {
  const r = loadSetupRun(id);
  return r && r.user_id === userId ? setupRunView(r) : null;
}

// A sheet's setup runs, newest first: the live ones and the last few that ended.
export function sheetSetupRuns(userId: string, sheetId: string, limit = 5): SetupRunView[] {
  const rows = db.prepare(`SELECT * FROM setup_runs WHERE sheet_id = ? AND user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(sheetId, userId, limit) as SetupRunRow[];
  return rows.map(setupRunView);
}
