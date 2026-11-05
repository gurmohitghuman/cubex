// An AI run's hard spend limit, kept by its worker (lib/ai-spend-limit.ts
// works the numbers out). Before each row the worker asks admit(): in one
// IMMEDIATE transaction it reads what the run spent (its usage record, which
// every row's cost reaches in the transaction that writes the row, migration
// 033, dropped calls included, 045) and what every worker of the run holds
// for its rows still out (ai_run_holds, migration 051), and either holds this
// row's most and lets it start, says wait, or says pause. Rows settle with
// settle(), which gives their hold back once their cost is in the usage record
// (a row cut off at its deadline keeps it: OpenRouter may bill that call with
// no cost reported); close() drops the worker's hold. So the run's rows out never count the same
// room twice, also when a resume starts a new worker while the old one's calls
// are still out. Only runs with a limit come here: the rest pay nothing for it.
import { db } from '../lib/db';
import { fetchModels } from '../lib/openrouter';
import { AI_HOLD_GRACE_MS, aiMaxTokens } from '../lib/constants';
import { processPromptTemplate } from '../lib/prompt';
import { buildMultiOutputInstruction, type OutputColumnSpec } from '../lib/ai-multi-output';
import {
  admitRow, priceModelId, rowMaxMicro, rowPricesOf, spendLimitMessage, webPart, type RowFixed, type RowPrices,
} from '../lib/ai-spend-limit';
import { redactError } from '../lib/redact';
import { WEB_SYSTEM_MESSAGE } from '../lib/ai-web-tools';
import type { AIRunRow, SheetRow } from './ai-runner-status';
import type { RowOutcome } from '../lib/run-breaker';
import { AI_TIMEOUT_MESSAGE } from './ai-row-outcome';

export type GateAnswer = { start: number } | { wait: true } | { pause: string };
export interface SpendGate {
  admit(row: SheetRow): GateAnswer;  // start: the micro-dollars held for this row
  settle(micro: number, outcome: RowOutcome | null): void;  // a row this worker started settled
  close(): void;                     // the worker's loop ended
}

const GRACE = `-${Math.ceil(AI_HOLD_GRACE_MS / 1000)} seconds`;
const bytes = (s: string | null | undefined): number => (s ? Buffer.byteLength(s, 'utf8') : 0);

// What the run spent so far: OpenRouter's charge and the user's own provider key's.
export function runSpentUsd(runId: string): number {
  return (db.prepare('SELECT ai_cost_usd + provider_cost_usd FROM run_usage WHERE run_id = ?').pluck()
    .get(runId) as number | undefined) ?? 0;
}

// What the run's other workers hold for their rows still out (an earlier
// generation's, finishing after a pause and a resume).
function heldByOthers(runId: string, generation: number): number {
  return db.prepare(`SELECT IFNULL(SUM(hold_micro), 0) FROM ai_run_holds
    WHERE run_id = ? AND worker_generation != ? AND updated_at > datetime('now', ?)`).pluck()
    .get(runId, generation, GRACE) as number;
}

function setHold(run: AIRunRow, generation: number, micro: number): void {
  db.prepare(`INSERT INTO ai_run_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?, ?, ?, ?)
    ON CONFLICT (run_id, worker_generation) DO UPDATE SET hold_micro = excluded.hold_micro,
      updated_at = datetime('now')`).run(run.id, generation, run.user_id, Math.max(0, micro));
}

// The model's listed prices (the worker's own cached model list); null: none listed.
async function modelPrices(model: string | null): Promise<RowPrices | null> {
  if (!model) return null;
  const result = await fetchModels(Date.now());
  const id = priceModelId(model);
  const m = (result.ok ? result.models : result.stale)?.find(x => x.id === id);
  return m ? rowPricesOf(m.pricing) : null;
}

// What every row of this run sends besides its own prompt, as ai-row.ts and ai-row-multi.ts build it.
export function rowFixedOf(run: AIRunRow): RowFixed {
  const search = !!run.use_openrouter_web_search, fetch = !!run.use_web_fetch;
  const web = webPart({
    model: run.model ?? '', search, fetch, used: run.web_search_engine_used ?? null,
    mode: run.web_search_mode ?? null, maxPerRow: run.web_search_max_per_row ?? null,
  });
  let fixedBytes: number, messages: number;
  if (run.output_columns) {
    const specs = JSON.parse(run.output_columns) as OutputColumnSpec[];
    const instruction = buildMultiOutputInstruction(specs, { withSources: search || fetch });
    fixedBytes = bytes(run.system_prompt) + bytes(`\n\n${instruction}`);
    messages = run.system_prompt ? 2 : 1;
  } else {
    const system = search || fetch ? WEB_SYSTEM_MESSAGE : run.system_prompt;
    fixedBytes = bytes(system);
    messages = system ? 2 : 1;
  }
  return {
    maxTokens: aiMaxTokens(run.max_chars), fixedBytes, messages, webTokens: web.tokens, webFeesUsd: web.feesUsd,
  };
}

export async function openSpendGate(run: AIRunRow, generation: number): Promise<SpendGate | null> {
  const limitUsd = run.spend_limit_usd;
  if (limitUsd === null || limitUsd === undefined) return null;
  const prices = await modelPrices(run.model);
  const fixed = rowFixedOf(run);
  const limitMicro = Math.floor(limitUsd * 1e6 + 1e-6);
  let mine = 0;  // what this worker's rows still out hold
  return {
    admit(row) {
      const rowMicro = prices ? rowMaxMicro(prices, fixed, bytes(processPromptTemplate(run.prompt, row.data))) : 0;
      const answer = db.transaction((): GateAnswer => {
        const spentMicro = Math.round(runSpentUsd(run.id) * 1e6);
        const heldMicro = mine + heldByOthers(run.id, generation);
        const decision = admitRow({ limitMicro, spentMicro, heldMicro, rowMicro });
        if (decision === 'wait') return { wait: true };
        if (decision === 'pause') {
          return { pause: spendLimitMessage(limitUsd, spentMicro / 1e6, prices ? rowMicro / 1e6 : null) };
        }
        setHold(run, generation, mine + rowMicro);
        return { start: rowMicro };
      }).immediate();
      // Counted once the hold is written: the row is this worker's until it settles.
      if ('start' in answer) mine += answer.start;
      return answer;
    },
    settle(micro, outcome) {
      // Cut off at its deadline, its call may still be billed, and no cost comes back: its most stays held.
      if (outcome?.kind === 'failed' && outcome.message === AI_TIMEOUT_MESSAGE) return;
      mine = Math.max(0, mine - micro);
      // Never throws: the worker drops its whole hold when it ends anyway.
      try { setHold(run, generation, mine); } catch (error) {
        console.error(`AI run ${run.id}: giving a row's hold back failed:`, redactError(error));
      }
    },
    close() {
      try {
        db.prepare('DELETE FROM ai_run_holds WHERE run_id = ? AND worker_generation = ?').run(run.id, generation);
      } catch (error) { console.error(`AI run ${run.id}: dropping its hold failed:`, redactError(error)); }
    },
  };
}
