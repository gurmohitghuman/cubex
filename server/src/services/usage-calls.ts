// Usage records for AI calls that aren't runs (migration 042): a preview's
// rows (mode 'preview') and an AI helper's calls (mode 'assist': writing a
// formula, an "Only run if" rule, an HTTP API column's request). Each use is
// one run_usage record of kind 'ai', so the usage history shows what it cost
// and the spend cap of the access token it was done for counts it
// (lib/actor.ts, services/token-spend.ts). Nothing else reads these records:
// they have no run behind them (their run_id starts with the mode).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { actorTokenId } from '../lib/actor';
import { redactError } from '../lib/redact';

export type CallMode = 'preview' | 'assist';
// calls: the AI calls made; cells: the rows a preview ran (an AI helper fills none).
export interface CallSpend { calls: number; cells: number; aiCostUsd: number; providerCostUsd: number }

export const noSpend = (): CallSpend => ({ calls: 0, cells: 0, aiCostUsd: 0, providerCostUsd: 0 });

export function addCall(s: CallSpend, cost: { costUsd?: number | null; providerCostUsd?: number | null }, cell = false)
  : void {
  s.calls++;
  if (cell) s.cells++;
  s.aiCostUsd += cost.costUsd ?? 0;
  s.providerCostUsd += cost.providerCostUsd ?? 0;
}

// Never throws: the calls were made (and billed) either way, so a record that fails is logged, not answered.
export function recordCallUsage(
  userId: string, sheetId: string, column: string | null, mode: CallMode, s: CallSpend,
): void {
  if (s.calls === 0) return;
  try {
    db.prepare(`INSERT INTO run_usage (run_id, user_id, sheet_id, kind, mode, column_name, started_at, status, cells,
        ai_cost_usd, provider_cost_usd, access_token_id)
      VALUES (?, ?, ?, 'ai', ?, ?, datetime('now'), 'completed', ?, ?, ?, ?)`)
      .run(`${mode}:${uuidv4()}`, userId, sheetId, mode, column, s.cells, s.aiCostUsd, s.providerCostUsd,
        actorTokenId());
  } catch (error) {
    console.error(`Recording what a ${mode} spent failed:`, redactError(error));
  }
}

// One AI helper's single call, as OpenRouter reported its cost (lib/responses-adapter.ts usageOf).
export function recordOneCall(
  userId: string, sheetId: string, cost: { costUsd: number | null; providerCostUsd: number | null },
): void {
  const s = noSpend();
  addCall(s, cost);
  recordCallUsage(userId, sheetId, null, 'assist', s);
}
