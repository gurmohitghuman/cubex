// Step answers a waterfall keeps so a step is never paid for twice
// (waterfall_step_answers, migration 038). A row's finished AI and HTTP steps
// are kept while the row is still running (scope: the run's key scope, the
// row's id), so a resume replays them at no cost; the row's write drops them.
// (treg steps need no journal: a resume re-sends the same Idempotency-Key and
// treg replays the paid answer free, services/enrich-step.ts.) A dry run's
// paid answers (treg and AI steps) are kept for any run (scope 'dry', no row:
// matched by the step and the inputs it read) for WATERFALL_ANSWER_KEEP_DAYS. An AI step's cost is
// added to its run the moment the call comes back, in the same transaction,
// so usage and the run's limit see it even when the row is stopped later.
// A row that ends failed keeps what it paid for, for a retry
// (services/waterfall-retry-kept.ts, scope 'miss').
// Runs in worker threads (plain DB reads and writes).
import { db } from '../lib/db';
import { WATERFALL_ANSWER_KEEP_DAYS } from '../lib/constants';
import { nowDate } from '../lib/clock';
import type { StepRun } from './waterfall-step-types';

export const DRY_SCOPE = 'dry';

export interface AnswerRef { userId: string; scope: string; rowRef: string; stepKey: string }
export interface KeptAnswer { run: StepRun; runId: string; createdAt: string }

const iso = (d: Date): string => d.toISOString();
const keepSince = (now: Date = nowDate()): string =>
  iso(new Date(now.getTime() - WATERFALL_ANSWER_KEEP_DAYS * 86_400_000));

// The newest kept answer for this step, young enough.
export function findKeptAnswer(ref: AnswerRef): KeptAnswer | null {
  const r = db.prepare(`SELECT outcome, run_id AS runId, created_at AS createdAt FROM waterfall_step_answers
    WHERE user_id = ? AND scope = ? AND row_ref = ? AND step_key = ? AND created_at >= ?
    ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(ref.userId, ref.scope, ref.rowRef, ref.stepKey, keepSince()) as
    { outcome: string; runId: string; createdAt: string } | undefined;
  if (!r) return null;
  try {
    const run = JSON.parse(r.outcome) as StepRun;
    return run && typeof run.outcome === 'string' ? { run, runId: r.runId, createdAt: r.createdAt } : null;
  } catch { return null; }
}

// A step's spend on its run: treg's charges are in the ledger already
// (enrich-ledger.ts recordCall); an AI step's are added here.
export function addAiSpend(runId: string, userId: string, run: StepRun): void {
  if (!run.costUsd && !run.aiProviderUsd) return;
  db.prepare(`UPDATE http_runs SET ai_cost_usd = ai_cost_usd + ?, ai_provider_cost_usd = ai_provider_cost_usd + ?
    WHERE id = ? AND user_id = ?`).run(run.costUsd, run.aiProviderUsd ?? 0, runId, userId);
}

// Kept for a replay (a finished step: an answer or a miss, never an error,
// which a resume tries again; keep false: only the AI cost is recorded). ai:
// the step's cost goes on the run too.
export function keepAnswer(ref: AnswerRef, runId: string, run: StepRun, o: { ai: boolean; keep: boolean }): void {
  db.transaction(() => {
    if (o.ai) addAiSpend(runId, ref.userId, run);
    if (!o.keep || run.outcome === 'error' || run.outcome === 'no_inputs') return;
    db.prepare(`INSERT INTO waterfall_step_answers (user_id, scope, row_ref, step_key, run_id, outcome, cost_usd,
        created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ref.userId, ref.scope, ref.rowRef, ref.stepKey, runId, JSON.stringify(run), run.costUsd, iso(nowDate()));
  }).immediate();
}

// Call inside the row's write: its own answers are no longer needed.
export function dropRowAnswers(userId: string, scope: string, rowRef: string): void {
  db.prepare('DELETE FROM waterfall_step_answers WHERE user_id = ? AND scope = ? AND row_ref = ?')
    .run(userId, scope, rowRef);
}

// The user's answers past their keep, a bounded page at a time (called as runs end).
export function pruneKeptAnswers(userId: string, limit = 5_000): number {
  return db.prepare(`DELETE FROM waterfall_step_answers WHERE id IN (
    SELECT id FROM waterfall_step_answers WHERE user_id = ? AND created_at < ? ORDER BY created_at LIMIT ?)`)
    .run(userId, keepSince(), limit).changes;
}
