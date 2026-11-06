// An AI run's hard spend limit, kept by its worker (lib/ai-spend-limit.ts
// works the numbers out). Before each row the worker asks admit(): in one
// IMMEDIATE transaction it reads what the run spent (its usage record, which
// every row's cost reaches in the transaction that writes the row, migration
// 033, dropped calls included, 045), what its calls cut off before they
// answered hold (ai_runs.spend_cut_off_micro, migration 052) and what every
// worker of the run holds for its rows still out (ai_run_holds, migration
// 051), and either holds this row's most and lets it start, says wait, or
// says pause (keeping that row's most on the run, for the least limit a
// resume needs: services/ai-run-limit.ts). Rows settle with settle(), which
// gives their hold back once their cost is in the usage record. A row whose
// call may be billed with no cost Cubex saw (cut off before its answer came
// back: services/ai-row-outcome.ts), also one a pause or a resume dropped,
// moves its most from its hold to the run's cut-off total, which counts as
// spent for the rest of the run, across resumes and restarts: the run pauses
// instead of waiting for room that never comes back. close() drops the worker's hold. So the run's rows out never
// count the same room twice, also when a resume starts a new worker while the
// old one's calls are still out. Only runs with a limit come here: the rest
// pay nothing for it. A model list that can't be read is tried again, then
// the run pauses: a priced model is never run as an unpriced or free one.
import { db } from '../lib/db';
import { fetchModels } from '../lib/openrouter';
import { AI_HOLD_GRACE_MS, AI_PRICE_READ_RETRY_MS, AI_PRICE_READ_TRIES } from '../lib/constants';
import { processPromptTemplate } from '../lib/prompt';
import type { OutputColumnSpec } from '../lib/ai-multi-output';
import {
  admitRow, priceModelId, PRICE_UNREAD_MESSAGE, rowFixedFor, rowMaxMicro, rowPricesOf, spendLimitMessage,
  type RowFixed, type RowPrices,
} from '../lib/ai-spend-limit';
import { redactError } from '../lib/redact';
import { micro } from '../lib/cost-ceiling';
import type { AIRunRow, SheetRow } from './ai-runner-status';
import type { RowOutcome } from '../lib/run-breaker';

// pause: why the run stops starting rows; reason: its pause_reason when it isn't spend_limit.
export type GateAnswer = { start: number } | { wait: true } | { pause: string; reason?: 'provider_errors' };
export interface SpendGate {
  admit(row: SheetRow): GateAnswer;  // start: the micro-dollars held for this row
  settle(micro: number, outcome: RowOutcome | null): void;  // a row this worker started settled
  close(): void;                     // the worker's loop ended
}

const GRACE = `-${Math.ceil(AI_HOLD_GRACE_MS / 1000)} seconds`;
const bytes = (s: string | null | undefined): number => (s ? Buffer.byteLength(s, 'utf8') : 0);

// What the run spent so far: OpenRouter's charge and the user's own provider key's.
export function runSpentUsd(runId: string, userId: string): number {
  return (db.prepare(`SELECT ai_cost_usd + provider_cost_usd FROM run_usage WHERE run_id = ? AND user_id = ?`)
    .pluck().get(runId, userId) as number | undefined) ?? 0;
}

// What the run's other workers hold for their rows still out (an earlier
// generation's, finishing after a pause and a resume).
function heldByOthers(run: AIRunRow, generation: number): number {
  return db.prepare(`SELECT IFNULL(SUM(hold_micro), 0) FROM ai_run_holds
    WHERE run_id = ? AND user_id = ? AND worker_generation != ? AND updated_at > datetime('now', ?)`).pluck()
    .get(run.id, run.user_id, generation, GRACE) as number;
}

function setHold(run: AIRunRow, generation: number, micro: number): void {
  db.prepare(`INSERT INTO ai_run_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?, ?, ?, ?)
    ON CONFLICT (run_id, worker_generation) DO UPDATE SET hold_micro = excluded.hold_micro,
      updated_at = datetime('now')`).run(run.id, generation, run.user_id, Math.max(0, micro));
}

// What the run's calls cut off before they answered hold, every worker's (migration 052).
export function runCutOffMicro(runId: string, userId: string): number {
  return (db.prepare('SELECT spend_cut_off_micro FROM ai_runs WHERE id = ? AND user_id = ?').pluck()
    .get(runId, userId) as number | undefined) ?? 0;
}
const addCutOff = (run: AIRunRow, micro: number): void => {
  db.prepare('UPDATE ai_runs SET spend_cut_off_micro = spend_cut_off_micro + ? WHERE id = ? AND user_id = ?')
    .run(micro, run.id, run.user_id);
};

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// The model's listed prices (the worker's own cached model list, a stale copy
// if that is all there is). null: none listed (an unknown id, a negative
// price); 'unread': no list could be read at all, after AI_PRICE_READ_TRIES.
export async function modelPrices(model: string | null): Promise<RowPrices | null | 'unread'> {
  if (!model) return null;
  const id = priceModelId(model);
  for (let attempt = 1; ; attempt++) {
    const result = await fetchModels(Date.now());
    const models = result.ok ? result.models : result.stale;
    if (models) {
      const m = models.find(x => x.id === id);
      return m ? rowPricesOf(m.pricing) : null;
    }
    if (attempt >= AI_PRICE_READ_TRIES) return 'unread';
    await pause(AI_PRICE_READ_RETRY_MS);
  }
}

// What every row of this run sends besides its own prompt (lib/ai-spend-limit.ts rowFixedFor).
export function rowFixedOf(run: AIRunRow): RowFixed {
  return rowFixedFor({
    model: run.model ?? '', systemPrompt: run.system_prompt ?? null, maxChars: run.max_chars ?? null,
    outputColumns: run.output_columns ? JSON.parse(run.output_columns) as OutputColumnSpec[] : null,
    web: {
      search: !!run.use_openrouter_web_search, fetch: !!run.use_web_fetch, used: run.web_search_engine_used ?? null,
      mode: run.web_search_mode ?? null, maxPerRow: run.web_search_max_per_row ?? null,
    },
  });
}

// columns: the sheet's columns as the run read them (ai-runner-lifecycle.ts), so a row's prompt is
// sized as it's sent (lib/prompt.ts processPromptTemplate).
export async function openSpendGate(
  run: AIRunRow, generation: number, columns: readonly string[],
): Promise<SpendGate | null> {
  const limitUsd = run.spend_limit_usd;
  if (limitUsd === null || limitUsd === undefined) return null;
  const prices = await modelPrices(run.model);
  if (prices === 'unread') {
    return { admit: () => ({ pause: PRICE_UNREAD_MESSAGE, reason: 'provider_errors' }), settle() {}, close() {} };
  }
  const fixed = rowFixedOf(run);
  // In whole micro-dollars, rounded as a resume checks it (ai-run-limit.ts) and the dialog does.
  const limitMicro = micro(limitUsd);
  let out = 0;      // what this worker's rows still out hold
  let unsaved = 0;  // cut-off calls' most this worker couldn't add to the run's total: its hold keeps it
  return {
    admit(row) {
      const rowMicro = prices
        ? rowMaxMicro(prices, fixed, bytes(processPromptTemplate(run.prompt, row.data, columns))) : 0;
      const answer = db.transaction((): GateAnswer => {
        const spentMicro = Math.round(runSpentUsd(run.id, run.user_id) * 1e6);
        const cutOff = runCutOffMicro(run.id, run.user_id) + unsaved;
        const heldMicro = out + heldByOthers(run, generation);
        const decision = admitRow({ limitMicro, spentMicro, heldMicro, stuckMicro: cutOff, rowMicro });
        if (decision === 'wait') return { wait: true };
        if (decision === 'pause') {
          db.prepare('UPDATE ai_runs SET spend_next_row_micro = ? WHERE id = ? AND user_id = ?')
            .run(prices ? rowMicro : null, run.id, run.user_id);
          return { pause: spendLimitMessage(limitUsd, spentMicro / 1e6, prices ? rowMicro / 1e6 : null, cutOff / 1e6) };
        }
        setHold(run, generation, out + unsaved + rowMicro);
        return { start: rowMicro };
      }).immediate();
      // Counted once the hold is written: the row is this worker's until it settles.
      if ('start' in answer) out += answer.start;
      return answer;
    },
    settle(micro, outcome) {
      out = Math.max(0, out - micro);
      // Its call may be billed and no cost came back (its row failed, or a pause or a resume dropped it):
      // its most counts as spent for the rest of the run.
      const cutOff = (outcome?.kind === 'failed' || outcome?.kind === 'dropped') && !!outcome.maybeBilled;
      // Never throws: the worker drops its whole hold when it ends anyway.
      try {
        db.transaction(() => {
          if (cutOff) addCutOff(run, micro);
          setHold(run, generation, out + unsaved);
        })();
      } catch (error) {
        if (cutOff) unsaved += micro;
        console.error(`AI run ${run.id}: giving a row's hold back failed:`, redactError(error));
      }
    },
    close() {
      try {
        db.transaction(() => {
          if (unsaved > 0) addCutOff(run, unsaved);
          db.prepare('DELETE FROM ai_run_holds WHERE run_id = ? AND worker_generation = ? AND user_id = ?')
            .run(run.id, generation, run.user_id);
        })();
      } catch (error) { console.error(`AI run ${run.id}: dropping its hold failed:`, redactError(error)); }
    },
  };
}
