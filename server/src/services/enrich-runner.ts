// The batch loop of an enrichment run, called by processHTTPRun once it has
// claimed a run whose config carries an `enrichment` block. Like the HTTP
// loop it follows the ⏳ rows a page at a time; before each batch it sizes the
// batch to what the run's spend limit and today's limit still allow (each row
// can cost up to the per-row cap, and what other batches hold for calls still
// out counts as spent), holds that room (services/enrich-holds.ts) and pauses
// when spending alone leaves no room for one more row (it waits when only
// holds are in the way). A row that hits a run-level stop (treg refused
// the key or the balance, treg can't be reached) halts the rest and pauses the
// run with the reason; rows stay ⏳.
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
import { dropHold, heldMicro, releaseRow, setHold, takeHold } from './enrich-holds';
import { processEnrichmentRow } from './enrich-row';
import { shouldStopHttpRun } from './run-row-write';
import { stopAutorunRun } from './autorun-stop';
import { destFullMessage, destRoom } from './enrich-list-room';
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

type Allowed = { n: number; rowMicro: number } | { reason: PauseReason; message: string } | { wait: true };

// How many more rows may start now (at most batchSize), or why none can. One
// IMMEDIATE transaction reads spent + held and takes the hold, so batches
// sized at once in other workers can't count the same room twice. Room that
// only other batches' holds fill is waited for (their calls settle and give
// back what they didn't spend), not paused on. A run with no per-row cap
// (null: the team's own provider key bills it, outside every limit here) or a
// $0 cap can't spend from treg: no limit stops it and it holds nothing.
function holdBatch(run: HTTPRunRow, config: EnrichRunConfig, generation: number, batchSize: number): Allowed {
  const e = config.enrichment;
  const cap = e.maxCostPerRowUsd ?? 0;
  const rowMicro = Math.max(0, Math.round(cap * 1e6));
  return db.transaction((): Allowed => {
    const spent = runSpentMicro(run.id, run.user_id) / 1e6;
    if (rowsThatFit(e.spendLimitUsd, spent, cap) < 1) {
      return {
        reason: 'spend_limit',
        message: `The run reached its ${money(e.spendLimitUsd ?? 0)} spend limit (${money(spent)} spent).`,
      };
    }
    // Only an earlier worker of this run (paused and resumed) can hold some of it.
    const byRun = rowsThatFit(e.spendLimitUsd, spent + heldMicro(run.user_id, run.id) / 1e6, cap);
    const limit = getDailyLimitMicro(run.user_id);
    const today = limit === null ? 0 : spentTodayMicro(run.user_id) / 1e6;
    if (limit !== null && rowsThatFit(limit / 1e6, today, cap) < 1) {
      return {
        reason: 'daily_limit',
        message: `Today's ${money(limit / 1e6)} enrichment limit is reached. It resets at midnight UTC.`,
      };
    }
    const byDay = limit === null ? Infinity : rowsThatFit(limit / 1e6, today + heldMicro(run.user_id) / 1e6, cap);
    if (byRun < 1 || byDay < 1) return { wait: true };
    // A list job stops before buying results its destination has no room for,
    // and buys at most the rows whose results fit.
    const dest = e.list ? destRoom(e.list.destSheetId, run.user_id) : null;
    if (dest && dest.room < 1) return { reason: 'dest_full', message: destFullMessage(dest.name) };
    const byRoom = dest && e.list ? Math.max(1, Math.floor(dest.room / e.list.maxItems)) : Infinity;
    const n = Math.min(batchSize, byRun, byDay, byRoom);
    takeHold(run.id, run.user_id, generation, n * rowMicro);
    return { n, rowMicro };
  }).immediate();
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
    let allowed = holdBatch(run, config, generation, batchSize);
    while ('wait' in allowed) {
      await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS));
      if (ctx.stopped()) return;
      allowed = holdBatch(run, config, generation, batchSize);
    }
    if ('reason' in allowed) { await stop(allowed.reason, allowed.message); return; }
    const rowMicro = allowed.rowMicro;
    // However the batch ends, its hold goes with it.
    try {
      // The key is read per batch: one removed in Settings pauses the run.
      const key = getTregToken(run.user_id);
      if (!key) { await stop('no_key', NO_KEY); return; }
      ctx.token = key;
      const batch: RunRow[] = [first.value];
      while (batch.length < allowed.n) {
        const next = await source.next();
        if (next.done) break;
        batch.push(next.value);
      }
      if (batch.length < allowed.n) setHold(run.id, generation, batch.length * allowed.rowMicro);
      // Calls in flight always finish, so their cost and call id reach the
      // ledger (treg bills them anyway); a stopped run then drops their writes
      // and a resume recovers or replays them for free. Only waits between
      // retries end early. Each row gives its hold back once it settles.
      const poll = setInterval(() => { if (ctx.stopped()) wake.abort(); }, STOP_POLL_MS);
      const columns = getSheetColumns(run.sheet_id, run.user_id, false);
      try {
        const settled = await Promise.allSettled(batch.map(row =>
          processEnrichmentRow(ctx, run, config, row, columns, generation)
            .finally(() => releaseRow(run.id, generation, rowMicro))));
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
    } finally { dropHold(run.id, generation); }
  }
}
