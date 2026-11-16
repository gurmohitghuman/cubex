// The setup sweep (API process): every SETUP_SWEEP_MS, each live setup record, oldest first, moved on
// (setup-runner.ts) or, paused, its runs kept paused (setup-step-state.ts holdPaused: a run still writing its
// placeholders when the pause came is paused once it can be). Each record is read again at its turn, not taken
// from the list: an earlier record's turn may await (a step's start), and a resume meanwhile would otherwise have
// its runs paused again by the status the list read.
import { db } from '../lib/db';
import { SETUP_SWEEP_MS } from '../lib/constants-setups';
import { advanceSetupRun } from './setup-runner';
import { holdPaused } from './setup-step-state';
import { loadSetupRun } from './setup-run-store';

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let afterTurn: ((id: string) => Promise<void>) | null = null;

export async function setupSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const live = db.prepare(`SELECT id FROM setup_runs WHERE status IN ('running', 'paused') ORDER BY created_at`)
      .pluck().all() as string[];
    for (const id of live) {
      try {
        const r = loadSetupRun(id);
        if (r?.status === 'paused') holdPaused(r);
        else if (r?.status === 'running') await advanceSetupRun(id);
      } catch (err) {
        console.error(`Setup run ${id} couldn't move on this round:`, err);
      }
      if (afterTurn) await afterTurn(id);
    }
  } finally { sweeping = false; }
}

export function startSetupLoop(): void {
  if (timer) return;
  timer = setInterval(() => { void setupSweep(); }, SETUP_SWEEP_MS);
  timer.unref?.();
}

// Tests only: run after each record's turn, before the next record is read.
export function setSweepTurnForTests(fn: ((id: string) => Promise<void>) | null): void { afterTurn = fn; }
