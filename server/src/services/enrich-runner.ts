// The batch loop of an enrichment run, called by processHTTPRun once it has
// claimed a run whose config carries an `enrichment` block. Like the HTTP
// loop it follows the ⏳ rows a page at a time; before each batch it sizes the
// batch to what the run's spend limit and today's limit still allow (each row
// can cost up to the per-row cap) and pauses when not one more row fits. A row
// that hits a run-level stop (treg refused the key or the balance, treg can't
// be reached) halts the rest and pauses the run with the reason; rows stay ⏳.
// An auto-run run cancels itself at those stops instead (services/autorun-stop.ts).
import { db } from '../lib/db';
import { ENRICH_DEFAULT_CONCURRENCY, HTTP_MAX_CONCURRENCY } from '../lib/constants';
import { runRows, countRunRows, type RunRow } from '../lib/run-rows';
import { rowsThatFit } from '../lib/enrich-estimate';
import type { PauseReason } from '../lib/enrich-errors';
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import { getSheetColumns } from '../lib/sql-helpers';
import { redactError } from '../lib/redact';
import { getDailyLimitMicro, getTregToken, spentTodayMicro } from './treg-key';
import { runSpentMicro } from './enrich-ledger';
import { processEnrichmentRow } from './enrich-row';
import { shouldStopHttpRun } from './run-row-write';
import { stopAutorunRun } from './autorun-stop';
import type { RunCtx } from './enrich-step';
import type { HTTPRunRow } from './http-runner-status';

const STOP_POLL_MS = 1000;
const NO_KEY = 'No treg key. Add one in Settings, then Resume.';
const money = (usd: number) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;

// CAS on (running, our generation): a user's pause, cancel or resume wins.
export function pauseEnrichmentRun(runId: string, generation: number, reason: PauseReason, message: string): void {
  db.prepare(`
    UPDATE http_runs SET status = 'paused', pause_reason = ?, error_message = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'running' AND worker_generation = ?
  `).run(reason, message.slice(0, 500), runId, generation);
}

// How many more rows may start now, or why none can.
function rowsAllowed(
  run: HTTPRunRow, config: EnrichRunConfig,
): { n: number } | { reason: PauseReason; message: string } {
  const e = config.enrichment;
  const cap = e.maxCostPerRowUsd ?? 0;
  const spent = runSpentMicro(run.id, run.user_id) / 1e6;
  const byRun = rowsThatFit(e.spendLimitUsd, spent, cap);
  if (byRun < 1) {
    return {
      reason: 'spend_limit',
      message: `The run reached its ${money(e.spendLimitUsd ?? 0)} spend limit (${money(spent)} spent).`,
    };
  }
  const limit = getDailyLimitMicro(run.user_id);
  const byDay = limit === null ? Infinity : rowsThatFit(limit / 1e6, spentTodayMicro(run.user_id) / 1e6, cap);
  if (byDay < 1) {
    return {
      reason: 'daily_limit',
      message: `Today's ${money((limit ?? 0) / 1e6)} enrichment limit is reached. It resets at midnight UTC.`,
    };
  }
  return { n: Math.min(byRun, byDay) };
}

export async function processEnrichmentRun(
  run: HTTPRunRow, config: EnrichRunConfig, generation: number, targets: number[] | null,
): Promise<void> {
  const wake = new AbortController();
  const ctx: RunCtx = {
    runId: run.id, userId: run.user_id, sheetId: run.sheet_id, statusColumn: run.master_column_name, token: '',
    autorunId: run.autorun_id ?? null,
    signal: wake.signal, stopped: () => shouldStopHttpRun(run.id, generation),
    halt: null, onHalt: () => wake.abort(), unreachableStreak: 0, sameLookup: new Map(),
  };
  const batchSize = Math.max(1, Math.min(config.batchSize ?? ENRICH_DEFAULT_CONCURRENCY, HTTP_MAX_CONCURRENCY));
  const masterCol = run.master_column_name;
  const remaining = countRunRows(run.sheet_id, run.user_id, masterCol, targets);
  let completed = masterCol ? Math.max(0, (run.total_rows || remaining) - remaining) : 0;
  const progress = db.prepare("UPDATE http_runs SET processed_rows = ?, updated_at = datetime('now') WHERE id = ?");
  const source = runRows(run.sheet_id, run.user_id, masterCol, targets)[Symbol.asyncIterator]();
  const stop = (reason: PauseReason, message: string): Promise<void> | void => (run.autorun_id
    ? stopAutorunRun(run, generation, reason, message, targets)
    : pauseEnrichmentRun(run.id, generation, reason, message));

  for (;;) {
    if (ctx.stopped()) return;
    // Limits are checked only when a row is waiting: a run whose last row
    // just spent the rest of its limit is done, not paused.
    const first = await source.next();
    if (first.done) return;
    const allowed = rowsAllowed(run, config);
    if ('reason' in allowed) { await stop(allowed.reason, allowed.message); return; }
    // The key is read per batch: one removed in Settings pauses the run.
    const key = getTregToken(run.user_id);
    if (!key) { await stop('no_key', NO_KEY); return; }
    ctx.token = key;
    const batch: RunRow[] = [first.value];
    while (batch.length < Math.min(batchSize, allowed.n)) {
      const next = await source.next();
      if (next.done) break;
      batch.push(next.value);
    }
    // Calls in flight always finish, so their cost and call id reach the
    // ledger (treg bills them anyway); a stopped run then drops their writes
    // and a resume replays them for free. Only waits between retries end early.
    const poll = setInterval(() => { if (ctx.stopped()) wake.abort(); }, STOP_POLL_MS);
    const columns = getSheetColumns(run.sheet_id, run.user_id, false);
    try {
      const settled = await Promise.allSettled(
        batch.map(row => processEnrichmentRow(ctx, run, config, row, columns, generation)),
      );
      // A row that threw keeps its ⏳ and no result, so the finalize fails the
      // run with "Some rows could not be processed" (a rerun retries them).
      for (const s of settled) {
        if (s.status === 'rejected') console.error(`Enrichment run ${run.id} row error:`, redactError(s.reason));
      }
    } finally { clearInterval(poll); }
    if (ctx.halt) {
      if (ctx.halt.reason === 'fail_run') throw new Error(ctx.halt.message);
      await stop(ctx.halt.reason, ctx.halt.message);
      return;
    }
    if (ctx.stopped()) return;
    completed += batch.length;
    progress.run(completed, run.id);
  }
}
