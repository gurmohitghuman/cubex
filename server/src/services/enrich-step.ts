// One step of an enrichment row: a single treg call, retried as the error
// classifier says (lib/enrich-errors.ts), each answer written to the ledger
// before anything else looks at it. Retries re-send the SAME Idempotency-Key,
// so a call treg already ran (and charged) is replayed for free.
import {
  ENRICH_FIRST_RETRY_MS, ENRICH_IDEMPOTENCY_WAIT_MS, ENRICH_SATURATION_RETRIES, ENRICH_UNREACHABLE_PAUSE_AFTER,
} from '../lib/constants';
import { classifyCall, detailOf, type PauseReason } from '../lib/enrich-errors';
import { idempotencyKey, keyPrefix, requestFingerprint, type KeyParts } from '../lib/enrich-request';
import { tregCall, type TregCallRequest } from '../lib/treg-call';
import type { TregMeta } from '../lib/treg-meta';
import { heldKeys, keysUsed, keyUsedByOtherRun, recordCall, seenCallId } from './enrich-ledger';

export const UNREACHABLE_MESSAGE = "Can't reach treg. Check the server's internet connection, then Resume.";
const PROVIDER_RETRIES = 2;
const SAME_LOOKUP_MAX = 5000;

export interface RunCtx {
  runId: string; userId: string; sheetId: string; statusColumn: string | null; token: string;
  autorunId: string | null;               // the auto-run that started the run, if one did
  signal: AbortSignal;                    // ends retry waits early; never aborts a call
  stopped: () => boolean;                 // paused, cancelled or superseded in the DB
  halt: { reason: PauseReason | 'fail_run'; message: string } | null;  // a row stopped the run
  onHalt: () => void;                     // wakes the other rows' retry waits
  unreachableStreak: number;
  sameLookup: Map<string, { rowIndex: number; result: Promise<StepResult> }>;
}

export type StepResult =
  | {
    kind: 'answer'; status: number; body: unknown; meta: TregMeta; costMicro: number;
    sameAsRow: number | null; oversize: boolean;
  }
  | { kind: 'row_skip' | 'row_fail'; message: string; costMicro: number }
  | { kind: 'pause'; reason: PauseReason; message: string; costMicro: number }
  | { kind: 'fail_run'; message: string; costMicro: number }
  | { kind: 'stopped'; costMicro: number };

export interface StepCall {
  toolId: string; attempt: string; rowIndex: number; rowId: string | null;
  parts: KeyParts; request: Omit<TregCallRequest, 'idempotencyKey'>;
}

// Whose keys a call uses. An auto-run keys by its entry and the row's id, so a
// row a stopped auto-run put back in the queue replays a paid answer for free
// in the next one (24 h), wherever the row has moved meanwhile.
export function keyScope(
  ctx: RunCtx, rowIndex: number, rowId: string | null,
): { scope: string; row: number | string } {
  return ctx.autorunId && rowId ? { scope: `a:${ctx.autorunId}`, row: rowId } : { scope: ctx.runId, row: rowIndex };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

const tierOf = (body: unknown): string | null => {
  const t = (body as { _treg?: { tier?: unknown } } | null)?._treg?.tier;
  return typeof t === 'string' ? t.slice(0, 40) : null;
};

const UNCONFIRMED = "treg hasn't confirmed a call for 15 minutes. "
  + 'Resume later to ask again; a call it finished is never charged twice.';
// Keys one call may move through: the ones its row's step already holds, then one new.
const MAX_KEY_HOPS = 10;

// rowCost is what the row's answer cost (a replay counts its first charge);
// the ledger records what each call adds (enrich-ledger.ts).
async function callOnce(ctx: RunCtx, s: StepCall): Promise<StepResult> {
  const at = keyScope(ctx, s.rowIndex, s.rowId);
  const keyOf = (a: string) => idempotencyKey(at.scope, at.row, a, s.parts);
  let attempt = s.attempt;
  let key = keyOf(attempt);
  let rowCost = 0, saturated = 0, providerTries = 0, waitedMs = 0, renewed = false, unanswered = 0, hops = 0;
  // The next key to ask: one this row's step already sent for this request
  // (it may hold a paid answer treg replays for free), in order, then a new number.
  const asked = new Set<string>();
  let held: Array<{ key: string; attempt: string }> | null = null;
  const nextKey = () => {
    asked.add(key);
    held ??= heldKeys(ctx.userId, s.rowId, keyPrefix(at.scope, at.row), s.attempt,
      requestFingerprint(s.parts).slice(0, 32));
    const h = held.find(k => !asked.has(k.key));
    attempt = h ? h.attempt
      : `${s.attempt}.${keysUsed(ctx.userId, s.rowId, keyPrefix(at.scope, at.row), s.attempt) + 1}`;
    key = h ? h.key : keyOf(attempt);
  };
  for (;;) {
    if (ctx.halt || ctx.stopped()) return { kind: 'stopped', costMicro: rowCost };
    // No abort signal: a call treg is running is billed whatever we do, so it
    // always finishes and its cost lands in the ledger.
    const ans = await tregCall(ctx.token, { ...s.request, idempotencyKey: key });
    // treg answers a repeated key from its store with the first call id.
    const replayed = ans.meta.replay || seenCallId(ctx.userId, s.rowId, key, ans.meta.callId);
    const replayedRefusal = ans.meta.tregError && replayed;
    if (ans.meta.callId || ans.meta.costMicro !== null) {
      rowCost += recordCall({
        userId: ctx.userId, sheetId: ctx.sheetId, runId: ctx.runId, rowId: s.rowId, statusColumn: ctx.statusColumn,
        toolId: s.toolId, attempt, idempotencyKey: key, httpStatus: ans.status,
        tregErrorCode: ans.meta.tregError ? detailOf(ans.body).code : null, tier: tierOf(ans.body), meta: ans.meta,
      }).rowMicro;
    }
    // A body cut off mid-read is asked again under the same key (a free replay).
    const verdict = ans.incomplete
      ? { kind: 'retry' as const, afterMs: ENRICH_FIRST_RETRY_MS, counts: 'unreachable' as const }
      : classifyCall({
        status: ans.status, tregError: ans.meta.tregError, callId: ans.meta.callId,
        retryAfterSec: ans.meta.retryAfterSec, body: ans.body,
      }, providerTries < PROVIDER_RETRIES);
    if (verdict.kind !== 'retry' || verdict.counts !== 'unreachable') ctx.unreachableStreak = 0;
    // A stop refusal treg kept for this key would come back on every resume,
    // after the user fixed the cause. And an auto-run row whose call failed in
    // an earlier run (a ❌ whose input was written, or a row put back in the
    // queue) would get that failure back. Both move on to the next key.
    const failed = verdict.kind === 'row_fail' || verdict.kind === 'row_skip'
      || (verdict.kind === 'retry' && verdict.counts === 'provider');
    const keptStop = verdict.kind === 'pause' && replayedRefusal;
    const oldFailure = !!ctx.autorunId && replayed && failed
      && keyUsedByOtherRun(ctx.userId, s.rowId, key, ctx.runId);
    if ((keptStop || oldFailure) && hops++ < MAX_KEY_HOPS) {
      nextKey();
      continue;
    }
    switch (verdict.kind) {
      case 'ok':
        return {
          kind: 'answer', status: ans.status as number, body: ans.body, meta: ans.meta, costMicro: rowCost,
          sameAsRow: null, oversize: !!ans.oversize,
        };
      case 'retry_new_attempt':
        // treg saw this key with another request: one more try under a new key.
        if (renewed) {
          return { kind: 'row_fail', message: verdict.message || 'treg refused the request key.', costMicro: rowCost };
        }
        renewed = true;
        attempt = `${attempt}r`;
        key = keyOf(attempt);
        continue;
      case 'retry':
        if (verdict.counts === 'unreachable') {
          // A call's first "no answer" (often a stale connection) retries at
          // once; only failures that persist count toward pausing the run.
          if (unanswered++ === 0) { await sleep(ENRICH_FIRST_RETRY_MS, ctx.signal); continue; }
          if (++ctx.unreachableStreak >= ENRICH_UNREACHABLE_PAUSE_AFTER) {
            return { kind: 'pause', reason: 'unreachable', message: UNREACHABLE_MESSAGE, costMicro: rowCost };
          }
        } else if (verdict.counts === 'saturation') {
          if (++saturated > ENRICH_SATURATION_RETRIES) {
            const message = 'treg is too busy right now. Resume in a few minutes.';
            return { kind: 'pause', reason: 'unreachable', message, costMicro: rowCost };
          }
        } else if (verdict.counts === 'provider') {
          providerTries++;
        } else {
          // 409: treg is still running the first call with this key. The row
          // stays ⏳ past 15 minutes, so a resume asks with the same key.
          waitedMs += verdict.afterMs;
          if (waitedMs > ENRICH_IDEMPOTENCY_WAIT_MS) {
            return { kind: 'pause', reason: 'unconfirmed', message: UNCONFIRMED, costMicro: rowCost };
          }
        }
        await sleep(verdict.afterMs, ctx.signal);
        continue;
      default:
        return { ...verdict, costMicro: rowCost };
    }
  }
}

// Identical lookups in one run go to treg once: later rows wait for the first
// row's answer and reuse it at $0 ("same lookup as row N"), a refused request
// included. A run-level stop is never shared: that row stays ⏳ for the resume.
export function runStep(ctx: RunCtx, s: StepCall): Promise<StepResult> {
  const fp = `${s.toolId}:${requestFingerprint(s.parts)}`;
  const seen = ctx.sameLookup.get(fp);
  if (seen && seen.rowIndex !== s.rowIndex) {
    return seen.result.then((r): StepResult => {
      if (r.kind === 'answer') return { ...r, costMicro: 0, sameAsRow: seen.rowIndex };
      if (r.kind === 'row_skip' || r.kind === 'row_fail') return { ...r, costMicro: 0 };
      return { kind: 'stopped', costMicro: 0 };
    });
  }
  const result = callOnce(ctx, s).then(r => {
    // The first row to hit a run-level stop halts the rest at their next call.
    if ((r.kind === 'pause' || r.kind === 'fail_run') && !ctx.halt) {
      ctx.halt = { reason: r.kind === 'pause' ? r.reason : 'fail_run', message: r.message };
      ctx.onHalt();
    }
    return r;
  });
  ctx.sameLookup.set(fp, { rowIndex: s.rowIndex, result });
  if (ctx.sameLookup.size > SAME_LOOKUP_MAX) ctx.sameLookup.delete(ctx.sameLookup.keys().next().value as string);
  return result;
}
