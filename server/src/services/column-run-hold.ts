// A column run holds the auto-run of each of its columns until that column's
// step starts (services/autorun-loop.ts asks): its rows stay queued, so an
// "all" or out-of-date run doesn't also pay for rows auto-run would take
// first, and a column waiting for an earlier one isn't run on its half-filled
// values. A paused run keeps holding; one that ended lets go. Once the step's
// run is going, that run holds the column as any run does.
import { db } from '../lib/db';
import type { SetupRunPlan, StepRecord } from './setup-run-store';

export function columnRunHolds(sheetId: string, userId: string, column: string): boolean {
  // Asked on every auto-run tick: through the small index of live records (idx_setup_runs_live), never the
  // sheet's index, which grows with every run the sheet ever had ('+' keeps the planner off it).
  const live = db.prepare(`SELECT plan, steps FROM setup_runs WHERE status IN ('running', 'paused')
    AND +sheet_id = ? AND +user_id = ? AND setup_id IS NULL`).all(sheetId, userId) as
    Array<{ plan: string; steps: string }>;
  for (const r of live) {
    const plan = JSON.parse(r.plan) as SetupRunPlan;
    const i = plan.columns?.steps.findIndex(s => s.column === column) ?? -1;
    if (i < 0) continue;
    const state = (JSON.parse(r.steps) as StepRecord[])[i]?.state;
    if (state === 'waiting' || state === 'starting') return true;
  }
  return false;
}
