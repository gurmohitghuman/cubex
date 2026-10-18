// Over 200 lines: the rolling row loop with its holds and limits, which only hold together.
// The row loop of a waterfall run, called by processHTTPRun once it has
// claimed a run whose config carries a `waterfall` block. Like the enrichment
// loop (services/enrich-runner.ts) it follows the ⏳ rows a page at a time,
// keeping up to its concurrency out at once. A waterfall with a paid step
// sizes the rows it starts to what its run limit (treg and AI spend) and
// today's enrichment limit (treg's part) still allow, holds that room while
// the rows are out (services/enrich-holds.ts), waits when only holds are in
// the way and pauses when spending alone leaves no room for one more row. A
// run-level stop a row meets (treg refused the key or the balance, treg can't
// be reached, OpenRouter refused the account) halts the rest and pauses the
// run with the reason; rows stay ⏳. An auto-run run cancels itself instead.
import { db } from '../lib/db';
import { runRows, countRunRows, type RunRow } from '../lib/run-rows';
import { limitReached, rowsThatFit } from '../lib/enrich-estimate';
import { enrichConcurrency } from '../lib/enrich-run-config';
import { redactError, redactSecrets } from '../lib/redact';
import { getSheetColumns } from '../lib/sql-helpers';
import {
  providerNamesFrom, rowSteps, type WaterfallRunConfig,
} from '../lib/waterfall/config';
import { dayCapOf, isPaidStep, tregPart, usesTreg } from '../lib/waterfall/caps';
import { getDailyLimitMicro, getTregToken, spentTodayMicro } from './treg-key';
import { getReuseDays } from './enrich-reuse';
import { dropHold, heldMicro, releaseRow, setRunHold } from './enrich-holds';
import { clearCooldowns } from './enrich-providers';
import { getOpenRouterClient } from './openrouter';
import { shouldStopHttpRun } from './run-row-write';
import { stopAutorunRun } from './autorun-stop';
import { processWaterfallRow, type WaterfallRowCtx } from './waterfall-row';
import { pruneKeptAnswers } from './waterfall-journal';
import { RunFormulas } from './waterfall-formulas';
import { RunLookups } from './waterfall-step-lookup';
import type { RunCtx } from './enrich-step';
import type { HTTPRunRow } from './http-runner-status';

const STOP_POLL_MS = 1000;
const NO_TREG_KEY = 'No treg key. Add one in Settings, then Resume.';
const NO_AI_KEY = 'No OpenRouter key. Add one in Settings, then Resume.';
const money = (usd: number) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;
const UNPRICED_NOTE = ' A treg step has no listed price (your own provider key should bill it), '
  + 'but what treg charges counts too.';

// CAS on (running, our generation): a user's pause, cancel or resume wins.
export function pauseWaterfallRun(runId: string, generation: number, reason: string, message: string): void {
  db.prepare(`
    UPDATE http_runs SET status = 'paused', pause_reason = ?, error_message = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'running' AND worker_generation = ?
  `).run(reason, redactSecrets(message).slice(0, 500), runId, generation);
}

// What the run spent: treg's charges (the ledger's counter) and its AI steps'.
export function runSpentWaterfallUsd(runId: string, userId: string): number {
  const r = db.prepare('SELECT spent_micro / 1e6 + ai_cost_usd AS s FROM http_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { s: number } | undefined;
  return r?.s ?? 0;
}

type Allowed = { n: number; tregMicro: number } | { reason: string; message: string } | { wait: true };

// How many more rows may start now, or why none can (see enrich-runner.ts
// holdRows: one IMMEDIATE transaction reads what is spent and held, and holds
// the room for the rows it lets start). Only treg's part of a row is held in
// enrich_holds, which every run's daily room reads; the AI part of this run's
// rows still out is counted here, for its own limit. A paid run whose steps
// have no known price (cap 0) stops on what it really spent; so does today's
// limit when a treg step has none.
function holdRows(run: HTTPRunRow, config: WaterfallRunConfig, generation: number, free: number, out: number)
  : Allowed {
  const w = config.waterfall;
  const treg = tregPart(config);
  const tregMicro = Math.max(0, Math.round(w.tregCapPerRowUsd * 1e6));
  const aiCap = Math.max(0, w.maxCostPerRowUsd - w.tregCapPerRowUsd);
  const rowCap = w.maxCostPerRowUsd > 0 ? w.maxCostPerRowUsd : null;
  return db.transaction((): Allowed => {
    if (tregMicro) setRunHold(run.id, run.user_id, generation, out * tregMicro);
    const spent = runSpentWaterfallUsd(run.id, run.user_id);
    if (limitReached(w.spendLimitUsd, spent, rowCap)) {
      return {
        reason: 'spend_limit',
        message: `The run reached its ${money(w.spendLimitUsd ?? 0)} spend limit (${money(spent)} spent).`,
      };
    }
    const inFlight = heldMicro(run.user_id, run.id) / 1e6 + out * aiCap;
    const byRun = rowCap === null ? Infinity : rowsThatFit(w.spendLimitUsd, spent + inFlight, rowCap);
    const limit = treg.any ? getDailyLimitMicro(run.user_id) : null;
    const today = limit === null ? 0 : spentTodayMicro(run.user_id) / 1e6;
    // The same per-row cap as the room below (a priced part waits for room, never forever).
    if (limit !== null && limitReached(limit / 1e6, today, dayCapOf(w.tregCapPerRowUsd, treg.unpriced))) {
      return {
        reason: 'daily_limit',
        message: `Today's ${money(limit / 1e6)} enrichment limit is reached. It resets at midnight UTC.`
          + (treg.unpriced ? UNPRICED_NOTE : ''),
      };
    }
    const byDay = limit === null ? Infinity
      : rowsThatFit(limit / 1e6, today + heldMicro(run.user_id) / 1e6, w.tregCapPerRowUsd);
    if (byRun < 1 || byDay < 1) return { wait: true };
    const n = Math.min(free, byRun, byDay);
    if (tregMicro) setRunHold(run.id, run.user_id, generation, (out + n) * tregMicro);
    return { n, tregMicro };
  }).immediate();
}

// A dry run's rows still to do: its targets without a result yet (a resume).
function dryRowsLeft(run: HTTPRunRow, targets: number[]): number[] {
  const done = new Set(db.prepare('SELECT row_index FROM http_results WHERE run_id = ? AND user_id = ?').pluck()
    .all(run.id, run.user_id) as number[]);
  return targets.filter(i => !done.has(i));
}

export async function processWaterfallRun(
  run: HTTPRunRow, config: WaterfallRunConfig, generation: number, allTargets: number[] | null,
): Promise<void> {
  const w = config.waterfall;
  const targets = w.dry && allTargets ? dryRowsLeft(run, allTargets) : allTargets;
  const steps = rowSteps(config);
  const wake = new AbortController();
  // A run-level stop a row met outside treg: OpenRouter refused the account, a formula ran too slow.
  const own: { halt: { reason: string; message: string } | null } = { halt: null };
  const enrich: RunCtx = {
    runId: run.id, userId: run.user_id, sheetId: run.sheet_id, statusColumn: run.master_column_name, token: '',
    autorunId: run.autorun_id ?? null,
    signal: wake.signal, stopped: () => shouldStopHttpRun(run.id, generation),
    halt: null, onHalt: () => wake.abort(), unreachableStreak: 0, sameLookup: new Map(), cooldown: new Map(),
    providerNames: providerNamesFrom(steps),
    reuseDays: w.fresh || w.noReuse ? 0 : getReuseDays(run.user_id),
  };
  const halted = () => !!enrich.halt || own.halt !== null;
  const stopped = () => halted() || enrich.stopped();
  const stop = (reason: string, message: string): Promise<void> | void => (run.autorun_id
    ? stopAutorunRun(run, generation, reason, message, targets)
    : pauseWaterfallRun(run.id, generation, reason, message));
  const needsTreg = steps.some(usesTreg);
  const needsAi = steps.some(s => s.built.kind === 'ai');
  if (needsTreg) {
    const key = getTregToken(run.user_id);
    if (!key) { await stop('no_key', NO_TREG_KEY); return; }
    enrich.token = key;
  }
  let ai: WaterfallRowCtx['ai'] = null;
  if (needsAi) {
    try { ai = await getOpenRouterClient(run.user_id); } catch { await stop('ai_key', NO_AI_KEY); return; }
  }
  clearCooldowns(run.id, run.user_id);
  // The sheet's columns, read at most once a second (input columns resolve against them).
  let columns: string[] = [];
  let columnsAt = 0;
  const sheetColumns = (): string[] => {
    if (Date.now() - columnsAt >= 1000) {
      columns = getSheetColumns(run.sheet_id, run.user_id, false);
      columnsAt = Date.now();
    }
    return columns;
  };
  const formulas = new RunFormulas(message => {
    if (own.halt === null) { own.halt = { reason: 'too_slow', message }; wake.abort(); }
  });
  const lookups = new RunLookups(run.id, run.user_id, stopped, !!run.autorun_id);
  const ctx: WaterfallRowCtx = {
    run, config, generation, enrich, ai, signal: wake.signal, stopped,
    halt: (message, reason = 'ai_key') => { if (own.halt === null) { own.halt = { reason, message }; wake.abort(); } },
    formulas, lookups,
    allowSavedKeys: run.allow_secrets !== 0, columns: sheetColumns,
  };
  const paid = steps.some(isPaidStep);
  const concurrency = enrichConcurrency(config);
  const masterCol = run.master_column_name;
  // A dry run's rows are its few targets (counting them would walk the whole sheet).
  const remaining = w.dry ? targets?.length ?? 0 : countRunRows(run.sheet_id, run.user_id, masterCol, targets);
  let completed = masterCol || w.dry ? Math.max(0, (run.total_rows || remaining) - remaining) : 0;
  const progress = db.prepare("UPDATE http_runs SET processed_rows = ?, updated_at = datetime('now') WHERE id = ?");
  const source = runRows(run.sheet_id, run.user_id, masterCol, targets)[Symbol.asyncIterator]();
  const out = new Set<Promise<void>>();
  let slotFreed: (() => void) | null = null;
  const rowSettled = () => new Promise<void>(resolve => { slotFreed = resolve; });
  let ended: { reason: string; message: string } | null = null;
  const poll = setInterval(() => { if (stopped()) wake.abort(); }, STOP_POLL_MS);
  try {
    rows: for (;;) {
      if (stopped()) break;
      if (out.size >= concurrency) { await rowSettled(); continue; }
      const first = await source.next();
      if (first.done) break;
      let allowed: Allowed = paid ? holdRows(run, config, generation, concurrency - out.size, out.size)
        : { n: concurrency - out.size, tregMicro: 0 };
      while ('wait' in allowed) {
        await (out.size > 0 ? rowSettled() : new Promise(resolve => setTimeout(resolve, STOP_POLL_MS)));
        if (stopped()) break rows;
        allowed = holdRows(run, config, generation, concurrency - out.size, out.size);
      }
      if ('reason' in allowed) { ended = allowed; break; }
      const { n, tregMicro } = allowed;
      const batch: RunRow[] = [first.value];
      while (batch.length < n) {
        const next = await source.next();
        if (next.done) break;
        batch.push(next.value);
      }
      if (batch.length < n && tregMicro) releaseRow(run.id, generation, (n - batch.length) * tregMicro);
      for (const row of batch) {
        // A row that threw keeps its ⏳ and no result: the finalize fails the run
        // with "Some rows could not be processed" (a rerun retries them).
        const done: Promise<void> = processWaterfallRow(ctx, row)
          .then(() => {}, error => { console.error(`Waterfall run ${run.id} row error:`, redactError(error)); })
          .finally(() => {
            if (tregMicro) releaseRow(run.id, generation, tregMicro);
            out.delete(done);
            const freed = slotFreed;
            slotFreed = null;
            freed?.();
            try {
              if (!stopped()) progress.run(++completed, run.id);
            } catch (error) { console.error(`Waterfall run ${run.id} progress error:`, redactError(error)); }
          });
        out.add(done);
      }
    }
  } finally {
    await Promise.allSettled([...out]);
    clearInterval(poll);
    formulas.dispose();
    lookups.dispose();
    if (paid) dropHold(run.id, generation);
    try { pruneKeptAnswers(run.user_id); } catch (error) {
      console.error('Pruning waterfall answers failed:', redactError(error));
    }
  }
  if (enrich.halt) {
    if (enrich.halt.reason === 'fail_run') throw new Error(enrich.halt.message);
    await stop(enrich.halt.reason, enrich.halt.message);
    return;
  }
  if (own.halt !== null) { await stop(own.halt.reason, own.halt.message); return; }
  if (enrich.stopped()) return;
  if (ended) await stop(ended.reason, ended.message);
}
