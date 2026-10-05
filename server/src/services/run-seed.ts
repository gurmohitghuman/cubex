// The heavy half of starting an AI or HTTP run, shared by every start and
// rerun path. The run row is inserted first, marked placeholder_work='seeding'
// (migration 004), and the start answers its caller right away (a long
// operation answers early and is tracked by its status: Google AIP-151,
// Microsoft REST guidelines). The '⏳ Processing...' placeholder then goes into
// every target row in slices (lib/placeholder-cells.ts) and only then is the
// run queued; get_run / the run pill show it as pending meanwhile. A restart in
// between fails the run (lib/orphan-runs.ts) instead of resuming one whose
// worker would skip the rows not yet seeded. The sheet stays busy
// (lib/sheet-busy.ts) until the run is queued, so no sort, import or column
// rewrite moves the rows meanwhile.
import { db } from '../lib/db';
import { continueInBackground, withSheetBusy } from '../lib/sheet-busy';
import { seedProcessingPlaceholders } from '../lib/placeholder-cells';
import { clearRunPlaceholders, type RunKind } from '../lib/run-placeholders';
import { redactSecrets } from '../lib/redact';
import type { RunFail } from './run-shared';

const TABLE: Record<RunKind, string> = { ai: 'ai_runs', http: 'http_runs' };

// Runs a start as the sheet's one heavy operation, or fails with the reason
// the sheet is busy.
export async function asRunStart<T extends object>(sheetId: string, work: () => Promise<T>): Promise<T | RunFail> {
  const outcome = await withSheetBusy(sheetId, 'starting a run', work);
  return 'busy' in outcome && typeof outcome.busy === 'string'
    ? { fail: 'conflict', message: outcome.busy }
    : outcome as T;
}

// How many rows the sheet has and its last row_index, from the index alone.
export function sheetRowSpan(sheetId: string, userId: string): { count: number; lastRow: number } {
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(row_index) AS last FROM rows WHERE sheet_id = ? AND user_id = ?')
    .get(sheetId, userId) as { n: number; last: number | null };
  return { count: r.n, lastRow: r.last ?? -1 };
}

// Seed, then queue, after the start has answered. Call inside asRunStart,
// right after the transaction that inserted the run with
// placeholder_work='seeding'. `queued` runs once the run is queued (not when
// it was cancelled while starting; its cancel clears the cells). If seeding or
// queueing throws, the run is failed with the reason and its cells cleared.
export function seedThenEnqueue(args: {
  kind: RunKind; runId: string; sheetId: string; userId: string; columns: string[];
  targets: number[] | null; lastRow: number; skip?: Set<number>;
  enqueue: () => Promise<void>; queued?: () => void;
}): void {
  continueInBackground(args.sheetId, 'starting a run', () => seedAndEnqueue(args));
}

async function seedAndEnqueue(args: Parameters<typeof seedThenEnqueue>[0]): Promise<void> {
  const table = TABLE[args.kind];
  const live = (): boolean => {
    const r = db.prepare(`SELECT status, placeholder_work FROM ${table} WHERE id = ?`).get(args.runId) as
      { status: string; placeholder_work: string | null } | undefined;
    return r?.status === 'pending' && r.placeholder_work === 'seeding';
  };
  const giveUp = async (error: unknown): Promise<never> => {
    const reason = error instanceof Error ? error.message : String(error);
    db.prepare(
      `UPDATE ${table} SET status = 'failed', error_message = ?, placeholder_work = 'clearing', updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    ).run(redactSecrets(`The run could not start: ${reason}`).slice(0, 500), args.runId);
    await clearRunPlaceholders(args.kind, args.runId);
    throw error;
  };

  let seeded: boolean;
  try {
    seeded = await seedProcessingPlaceholders({ ...args, live });
  } catch (error) {
    return giveUp(error);
  }
  if (!seeded) return;

  // Fully seeded: drop the mark in the same tick as this check, so from here a
  // restart resumes the run like any other pending one. Open grids reload to
  // show the placeholders.
  const ready = db.transaction(() => {
    const r = db.prepare(
      `UPDATE ${table} SET placeholder_work = NULL WHERE id = ? AND status = 'pending' AND placeholder_work = 'seeding'`,
    ).run(args.runId);
    db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(args.sheetId, args.userId);
    return r.changes > 0;
  })();
  if (!ready) return;
  // Queueing doesn't need the rows to hold still, so the sheet is released now.
  args.enqueue().then(
    () => args.queued?.(),
    error => giveUp(error).catch(err => console.error(`Queueing ${args.kind} run ${args.runId} failed:`, err)),
  );
}
