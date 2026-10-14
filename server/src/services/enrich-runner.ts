// The row loop of an enrichment run, called by processHTTPRun once it has
// claimed a run whose config carries an `enrichment` block. Like the HTTP
// loop it follows the ⏳ rows a page at a time, keeping up to its concurrency
// out at once; before starting rows it sizes them to what the run's spend
// limit and today's limit still allow (each row can cost up to the per-row
// cap, and what rows still out hold counts as spent), holds that room
// (services/enrich-holds.ts) and pauses
// when spending alone leaves no room for one more row (it waits when only
// holds are in the way). A run with no per-row cap stops at a limit only
// once what treg really billed reaches it. A row that hits a run-level stop
// (treg refused the key or the balance, treg can't be reached) halts the rest
// and pauses the run with the reason; rows stay ⏳.
// An auto-run run cancels itself at those stops instead (services/autorun-stop.ts).
import { db } from '../lib/db';
import { runRows, countRunRows, type RunRow } from '../lib/run-rows';
import { limitReached, rowsThatFit, UNCAPPED_BILLED_NOTE } from '../lib/enrich-estimate';
import type { PauseReason } from '../lib/enrich-errors';
import { enrichConcurrency, type EnrichRunConfig } from '../lib/enrich-run-config';
import { getSheetColumns } from '../lib/sql-helpers';
import { redactError, redactSecrets } from '../lib/redact';
import { getDailyLimitMicro, getTregToken, spentTodayMicro } from './treg-key';
import { runSpentMicro } from './enrich-ledger';
import { dropHold, heldMicro, releaseRow, setRunHold } from './enrich-holds';
import { processEnrichmentRow } from './enrich-row';
import { clearCooldowns } from './enrich-providers';
import { shouldStopHttpRun } from './run-row-write';
import { stopAutorunRun } from './autorun-stop';
import { destFullMessage, destRoom } from './enrich-list-room';
import type { RunCtx } from './enrich-step';
import type { HTTPRunRow } from './http-runner-status';

const STOP_POLL_MS = 1000;
const NO_KEY = 'No treg key. Add one in Settings, then Resume.';
const money = (usd: number) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;

// CAS on (running, our generation): a user's pause, cancel or resume wins.
// Redacted: the message can carry treg's own detail text (lib/enrich-errors.ts).
export function pauseEnrichmentRun(runId: string, generation: number, reason: PauseReason, message: string): void {
  db.prepare(`
    UPDATE http_runs SET status = 'paused', pause_reason = ?, error_message = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'running' AND worker_generation = ?
  `).run(reason, redactSecrets(message).slice(0, 500), runId, generation);
}

type Allowed = { n: number; rowMicro: number } | { reason: PauseReason; message: string } | { wait: true };

// How many more rows may start now (at most `free`; `out` of this run's are
// still out), or why none can. One IMMEDIATE transaction reads spent + held and
// adds to the hold, so rows sized at once in other workers can't count the
// same room twice. Room that only holds fill is waited for (their calls settle and give
// back what they didn't spend), not paused on. A run with no per-row cap
// (null: the team's own provider key should bill it) or a $0 cap holds
// nothing; the null one still stops once what treg really billed reaches a
// limit (lib/enrich-estimate.ts limitReached).
function holdRows(run: HTTPRunRow, config: EnrichRunConfig, generation: number, free: number, out: number): Allowed {
  const e = config.enrichment;
  const cap = e.maxCostPerRowUsd ?? 0;
  const rowMicro = Math.max(0, Math.round(cap * 1e6));
  // Said in the pause: the run has no per-row cap, so what treg charged stopped it.
  const billed = e.maxCostPerRowUsd === null ? ` ${UNCAPPED_BILLED_NOTE}` : '';
  return db.transaction((): Allowed => {
    // This worker's hold is exactly its rows still out: a release that failed
    // is corrected here instead of shrinking the room until the run ends.
    setRunHold(run.id, run.user_id, generation, out * rowMicro);
    const spent = runSpentMicro(run.id, run.user_id) / 1e6;
    if (limitReached(e.spendLimitUsd, spent, e.maxCostPerRowUsd)) {
      return {
        reason: 'spend_limit',
        message: `The run reached its ${money(e.spendLimitUsd ?? 0)} spend limit (${money(spent)} spent).${billed}`,
      };
    }
    // This worker's rows still out hold some of it, and maybe an earlier worker's (paused and resumed).
    const byRun = rowsThatFit(e.spendLimitUsd, spent + heldMicro(run.user_id, run.id) / 1e6, cap);
    const limit = getDailyLimitMicro(run.user_id);
    const today = limit === null ? 0 : spentTodayMicro(run.user_id) / 1e6;
    if (limit !== null && limitReached(limit / 1e6, today, e.maxCostPerRowUsd)) {
      const spentToday = billed ? ` (${money(today)} spent today)` : '';
      return {
        reason: 'daily_limit',
        message: `Today's ${money(limit / 1e6)} enrichment limit is reached${spentToday}.`
          + ` It resets at midnight UTC.${billed}`,
      };
    }
    const byDay = limit === null ? Infinity : rowsThatFit(limit / 1e6, today + heldMicro(run.user_id) / 1e6, cap);
    if (byRun < 1 || byDay < 1) return { wait: true };
    // A list job stops before buying results its destination has no room for,
    // and buys at most the rows whose results fit.
    const dest = e.list ? destRoom(e.list.destSheetId, run.user_id) : null;
    if (dest && dest.room < 1) return { reason: 'dest_full', message: destFullMessage(dest.name) };
    // Results of this run's rows still out aren't waiting for room yet: they count too.
    const byRoom = dest && e.list ? Math.max(1, Math.floor(dest.room / e.list.maxItems)) - out : Infinity;
    if (byRoom < 1) return { wait: true };
    const n = Math.min(free, byRun, byDay, byRoom);
    setRunHold(run.id, run.user_id, generation, (out + n) * rowMicro);
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
    halt: null, onHalt: () => wake.abort(), unreachableStreak: 0, sameLookup: new Map(), cooldown: new Map(),
    providerNames: config.enrichment.providerNames,
  };
  const concurrency = enrichConcurrency(config);
  clearCooldowns(run.id, run.user_id);
  const masterCol = run.master_column_name;
  const remaining = countRunRows(run.sheet_id, run.user_id, masterCol, targets);
  let completed = masterCol ? Math.max(0, (run.total_rows || remaining) - remaining) : 0;
  const progress = db.prepare("UPDATE http_runs SET processed_rows = ?, updated_at = datetime('now') WHERE id = ?");
  const source = runRows(run.sheet_id, run.user_id, masterCol, targets)[Symbol.asyncIterator]();
  const stop = (reason: PauseReason, message: string): Promise<void> | void => (run.autorun_id
    ? stopAutorunRun(run, generation, reason, message, targets)
    : pauseEnrichmentRun(run.id, generation, reason, message));

  // Rolling: a row starts as soon as one settles, up to `concurrency` at once
  // (batches that waited for their slowest row ran a 5-second waterfall at
  // about one row a second). Calls in flight always finish, so their cost and
  // call id reach the ledger (treg bills them anyway); a stopped run then drops
  // their writes and a resume recovers or replays them for free. Only waits
  // between retries end early. Each row gives its hold back once it settles.
  const out = new Set<Promise<void>>();
  let ended: { reason: PauseReason; message: string } | null = null;
  const poll = setInterval(() => { if (ctx.stopped()) wake.abort(); }, STOP_POLL_MS);
  try {
    rows: for (;;) {
      if (ctx.stopped() || ctx.halt) break;
      if (out.size >= concurrency) { await Promise.race(out); continue; }
      // Limits are checked only when a row is waiting: a run whose last row
      // just spent the rest of its limit is done, not paused.
      const first = await source.next();
      if (first.done) break;
      let allowed = holdRows(run, config, generation, concurrency - out.size, out.size);
      while ('wait' in allowed) {
        // This run's own rows still out hold some of the room: one settling gives it back.
        await (out.size > 0 ? Promise.race(out) : new Promise(resolve => setTimeout(resolve, STOP_POLL_MS)));
        if (ctx.stopped() || ctx.halt) break rows;
        allowed = holdRows(run, config, generation, concurrency - out.size, out.size);
      }
      if ('reason' in allowed) { ended = allowed; break; }
      const { n, rowMicro } = allowed;
      // The key is read before rows start: one removed in Settings pauses the run.
      const key = getTregToken(run.user_id);
      if (!key) {
        releaseRow(run.id, generation, n * rowMicro);
        ended = { reason: 'no_key', message: NO_KEY };
        break;
      }
      ctx.token = key;
      const batch: RunRow[] = [first.value];
      while (batch.length < n) {
        const next = await source.next();
        if (next.done) break;
        batch.push(next.value);
      }
      if (batch.length < n) releaseRow(run.id, generation, (n - batch.length) * rowMicro);
      const columns = getSheetColumns(run.sheet_id, run.user_id, false);
      for (const row of batch) {
        // A row that threw keeps its ⏳ and no result, so the finalize fails the
        // run with "Some rows could not be processed" (a rerun retries them).
        const done: Promise<void> = processEnrichmentRow(ctx, run, config, row, columns, generation)
          .catch(error => { console.error(`Enrichment run ${run.id} row error:`, redactError(error)); })
          .finally(() => {
            releaseRow(run.id, generation, rowMicro);
            out.delete(done);
            // Never rejects: nothing may be waiting on this row yet (a worker
            // thread dies on an unhandled rejection); a missed count is fixed
            // by the next one, and a resume recounts.
            try {
              if (!ctx.halt && !ctx.stopped()) progress.run(++completed, run.id);
            } catch (error) { console.error(`Enrichment run ${run.id} progress error:`, redactError(error)); }
          });
        out.add(done);
      }
    }
  } finally {
    await Promise.allSettled([...out]);
    clearInterval(poll);
    dropHold(run.id, generation);
  }
  if (ctx.halt) {
    if (ctx.halt.reason === 'fail_run') throw new Error(ctx.halt.message);
    await stop(ctx.halt.reason, ctx.halt.message);
    return;
  }
  if (ctx.stopped()) return;
  if (ended) await stop(ended.reason, ended.message);
}
