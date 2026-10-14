// One step of an enrichment row: a single treg call, retried as the error
// classifier says (lib/enrich-errors.ts), each answer written to the ledger
// before anything else looks at it. Retries re-send the SAME Idempotency-Key,
// so a call treg already ran (and charged) is replayed for free.
// Over 200 lines: one call's retry loop with its ledger and key rules, which only hold together.
import {
  ENRICH_FIRST_RETRY_MS, ENRICH_IDEMPOTENCY_WAIT_MS, ENRICH_PROVIDER_RATE_RETRIES, ENRICH_PROVIDER_RETRIES,
  ENRICH_SATURATION_RETRIES, ENRICH_UNREACHABLE_PAUSE_AFTER,
} from '../lib/constants';
import { classifyCall, detailOf, rateLimitWaitMs, type PauseReason } from '../lib/enrich-errors';
import { routeCharged } from '../lib/enrich-route-failure';
import { idempotencyKey, keyPrefix, requestFingerprint, type KeyParts } from '../lib/enrich-request';
import { tregCall, type TregCallRequest } from '../lib/treg-call';
import type { TregMeta } from '../lib/treg-meta';
import { heldKeys, keysUsed, keyUsedByOtherRun, recordCall, seenCallId } from './enrich-ledger';
import { noteTregReach, tregAnswered } from './treg-reach';
import { providerTries as triesOf } from '../lib/enrich-provider-tries';
import { excludeWithCooldown, noteProviderTries, type Cooldown } from './enrich-providers';

export const UNREACHABLE_MESSAGE = "Can't reach treg. Check the server's internet connection, then Resume.";
const BUSY_RETRIES = 3;
// treg's refusals when no provider of a waterfall can take the row.
const ROUTE_REFUSALS = new Set(['no_route_candidate', 'route_max_cost', 'route_failed']);
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
  cooldown: Cooldown;                     // providers its waterfalls leave out for now (enrich-providers.ts)
  providerNames?: Record<string, string>; // treg's provider ids -> the names the run shows
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
  // 429 retries left, shared by a row's steps (a verified email's finds and
  // checks) so a rate-limited row waits minutes, not one budget per step.
  rateRetries?: { left: number };
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

// rowCost is what the row's answer cost (a replay counts its first charge,
// once: not when this step already counted that key's charge, as after a body
// cut off mid-read); the ledger records what each call adds (enrich-ledger.ts).
async function callOnce(ctx: RunCtx, s: StepCall): Promise<StepResult> {
  const at = keyScope(ctx, s.rowIndex, s.rowId);
  const keyOf = (a: string) => idempotencyKey(at.scope, at.row, a, s.parts);
  let attempt = s.attempt;
  let key = keyOf(attempt);
  let rowCost = 0, saturated = 0, providerTries = 0, waitedMs = 0, renewed = false, unanswered = 0, hops = 0;
  const rate = s.rateRetries ?? { left: ENRICH_PROVIDER_RATE_RETRIES };
  let busy = 0, cool = true;
  const triesCounted = new Set<string>();   // call ids whose providers noteProviderTries counted
  const cutOff = new Set<string>();         // call ids whose answer came back cut off (not counted)
  // The next key to ask: one this row's step already sent for this request
  // (it may hold a paid answer treg replays for free), in order, then a new number.
  const asked = new Set<string>();
  const counted = new Set<string>();   // keys whose charge rowCost holds
  let held: Array<{ key: string; attempt: string }> | null = null;
  const nextKey = () => {
    asked.add(key);
    held ??= heldKeys(ctx.userId, s.rowId, keyPrefix(at.scope, at.row), s.attempt,
      requestFingerprint(s.parts).slice(0, 32));
    const h = held.find(k => !asked.has(k.key));
    if (h) { attempt = h.attempt; key = h.key; return; }
    // A key the ledger never saw (no call id) isn't counted: step past those asked.
    let n = keysUsed(ctx.userId, s.rowId, keyPrefix(at.scope, at.row), s.attempt) + 1;
    while (asked.has(keyOf(`${s.attempt}.${n}`))) n++;
    attempt = `${s.attempt}.${n}`;
    key = keyOf(attempt);
  };
  for (;;) {
    if (ctx.halt || ctx.stopped()) return { kind: 'stopped', costMicro: rowCost };
    // No abort signal: a call treg is running is billed whatever we do, so it
    // always finishes and its cost lands in the ledger.
    // A provider cooling down is left out of the header only (and of prefer):
    // the key stays the column's, so a retry or resume replays what this call got.
    const exclude = s.request.routed && cool
      ? excludeWithCooldown(ctx, s.toolId, s.request.exclude) : s.request.exclude;
    const cooled = exclude !== s.request.exclude;
    const prefer = cooled ? s.request.prefer?.filter(p => !exclude?.includes(p)) : s.request.prefer;
    const ans = await tregCall(ctx.token, { ...s.request, exclude, prefer, idempotencyKey: key });
    noteTregReach(ctx.userId, tregAnswered({ ...ans, callId: ans.meta.callId, tregError: ans.meta.tregError }));
    // treg answers a repeated key from its store with the first call id.
    const knownCall = seenCallId(ctx.userId, s.rowId, key, ans.meta.callId);
    const replayed = ans.meta.replay || knownCall;
    const replayedRefusal = ans.meta.tregError && replayed;
    if (ans.meta.callId || ans.meta.costMicro !== null) {
      const { rowMicro } = recordCall({
        userId: ctx.userId, sheetId: ctx.sheetId, runId: ctx.runId, rowId: s.rowId, statusColumn: ctx.statusColumn,
        toolId: s.toolId, attempt, idempotencyKey: key, httpStatus: ans.status,
        tregErrorCode: ans.meta.tregError ? detailOf(ans.body).code : null, tier: tierOf(ans.body), meta: ans.meta,
      });
      // A replay of a charge this step counted is that same charge. One it
      // didn't (a resume: an earlier worker's call) is what the row cost.
      if (rowMicro > 0 && !(ans.meta.replay && counted.has(key))) {
        rowCost += rowMicro;
        counted.add(key);
      }
    }
    // Counted for each call treg ran, from its first whole answer: a call id
    // the ledger didn't know (a new call, or the replay of one whose reply was
    // lost), or, once, the replay of one whose reply was cut off. A failure
    // treg didn't keep runs again under its key, with a new call id.
    const callId = ans.meta.callId;
    if (ans.incomplete) { if (callId) cutOff.add(callId); }
    else if (!knownCall || (callId && cutOff.has(callId) && !triesCounted.has(callId))) {
      if (callId) triesCounted.add(callId);
      noteProviderTries(ctx, s.toolId, triesOf(ans.body, ans.meta, ans.status));
    }
    // A body cut off mid-read is asked again under the same key (a free replay).
    const verdict = ans.incomplete
      ? { kind: 'retry' as const, afterMs: ENRICH_FIRST_RETRY_MS, counts: 'unreachable' as const }
      : classifyCall({
        status: ans.status, tregError: ans.meta.tregError, callId: ans.meta.callId,
        retryAfterSec: ans.meta.retryAfterSec, body: ans.body,
      // A failure treg kept for the key would only come back: no retries for it.
      }, { provider: !replayed && providerTries < ENRICH_PROVIDER_RETRIES, rateLimit: !replayed && rate.left > 0 },
      ctx.providerNames);
    if (verdict.kind !== 'retry' || verdict.counts !== 'unreachable') ctx.unreachableStreak = 0;
    // A stop refusal treg kept for this key would come back on every resume,
    // after the user fixed the cause. And an auto-run row whose call failed in
    // an earlier run (a ❌ whose input was written, or a row put back in the
    // queue) would get that failure back. Both move on to the next key.
    const providerRetry = verdict.kind === 'retry'
      && (verdict.counts === 'provider' || verdict.counts === 'rate_limit');
    const failed = verdict.kind === 'row_fail' || verdict.kind === 'row_skip' || providerRetry;
    const keptStop = verdict.kind === 'pause' && replayedRefusal;
    const oldFailure = !!ctx.autorunId && replayed && failed
      && keyUsedByOtherRun(ctx.userId, s.rowId, key, ctx.runId);
    if ((keptStop || oldFailure) && hops++ < MAX_KEY_HOPS) {
      nextKey();
      continue;
    }
    // No provider left for the row once a cool-down left some out (or such a
    // refusal kept for this key): asked once more, without the cool-down, under
    // a new key, before any wait. Only a refusal that charged nothing: one that
    // did is kept by treg, and a new key would buy the waterfall again.
    const refusal = detailOf(ans.body);
    const routeRefusal = (verdict.kind === 'row_skip' || verdict.kind === 'row_fail' || providerRetry)
      && ROUTE_REFUSALS.has(refusal.code ?? '') && !routeCharged(refusal.detail);
    if (routeRefusal && cool && (cooled || replayedRefusal) && hops++ < MAX_KEY_HOPS) {
      cool = false;
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
        } else if (verdict.counts === 'rate_limit') {
          await sleep(rateLimitWaitMs(ENRICH_PROVIDER_RATE_RETRIES - rate.left--, verdict.afterMs), ctx.signal);
          continue;
        } else if (verdict.counts === 'busy') {
          // Asked again under the same key, which can never be billed twice; a
          // refusal treg kept for the key would only come back, so the row ends.
          if (replayed || ++busy > BUSY_RETRIES) {
            return { kind: 'row_fail', message: verdict.message, costMicro: rowCost };
          }
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
