// What a treg answer means for an enrichment run (pure). Codes and shapes are
// from treg's source: its own refusals carry X-Treg-Error: 1 and a {"detail"}
// body (a string, or {"error": code, …}); the pool-saturation 503 is the one
// refusal without that header; provider errors are relayed verbatim.
import {
  ENRICH_RETRY_MS, ENRICH_UNREACHABLE_RETRY_MS, ENRICH_PROVIDER_RATE_RETRY_MS, ENRICH_PROVIDER_RATE_RETRY_MAX_MS,
  ENRICH_SHARE_BUSY_MIN_MS, ENRICH_SHARE_BUSY_MAX_MS, ENRICH_SATURATION_MAX_MS,
} from './constants';
import { providerText, routeFailure } from './enrich-route-failure';
export type PauseReason =
  | 'auth' | 'balance' | 'treg_cap' | 'team_rule' | 'provider_busy' | 'unreachable'
  | 'spend_limit' | 'daily_limit' | 'dest_full' | 'no_key' | 'unconfirmed'
  | 'token_cap';   // the run's access token reached its spend cap (services/token-spend.ts)

export type CallVerdict =
  | { kind: 'ok' }
  | { kind: 'retry'; afterMs: number; counts: 'unreachable' | 'saturation' | 'provider' | 'in_progress' }
  // A provider's 429: afterMs is its Retry-After (0: none); the step backs off (rateLimitWaitMs).
  | { kind: 'retry'; afterMs: number; counts: 'rate_limit' }
  // treg's shared key for a provider is busy: nothing was sent or billed. Retried
  // under the same key; `message` if it stays busy.
  | { kind: 'retry'; afterMs: number; counts: 'busy'; message: string }
  | { kind: 'retry_new_attempt'; message: string }
  | { kind: 'row_skip'; message: string }
  | { kind: 'row_fail'; message: string }
  | { kind: 'pause'; reason: PauseReason; message: string }
  | { kind: 'fail_run'; message: string };

// Whether a row may still ask again after a provider's 5xx, and after its 429.
export interface RetriesLeft { provider: boolean; rateLimit: boolean }

export interface CallAnswer {
  status: number | null;        // null: no response (network error, timeout)
  tregError: boolean;           // X-Treg-Error: 1
  callId: string | null;        // X-Treg-Call-Id
  retryAfterSec: number | null;
  body: unknown;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export function detailOf(body: unknown): { code: string | null; text: string; detail: Json | null } {
  const d = isObj(body) ? body.detail : undefined;
  if (typeof d === 'string') return { code: null, text: d, detail: null };
  if (isObj(d)) return { code: typeof d.error === 'string' ? d.error : null, text: String(d.message ?? d.error ?? ''), detail: d };
  return { code: null, text: '', detail: null };
}

const usd = (micro: unknown) => (typeof micro === 'number' ? `$${(micro / 1e6).toFixed(2)}` : null);

// treg's key refusals (identity/access.py), by their exact words. A bare
// "token" would also catch tool-policy refusals ("this token is not allowed").
const KEY_REFUSALS = /invalid token|not authenticated|disabled key|revoked key|account suspended|org suspended|not a member of this org|membership removed|no session/i;

function balanceMessage(d: Json | null): string {
  const left = usd(d?.balance_micro);
  if (d?.autotopup_enabled === true) {
    return `Your treg balance ran out${left ? ` (${left} left)` : ''}. Auto top-up is on at treg but is held by its cooldown or monthly cap.`;
  }
  return `Your treg balance ran out${left ? ` (${left} left)` : ''}. Top up at treg, then Resume.`;
}

function tregRefusal(a: CallAnswer, left: RetriesLeft, names: Record<string, string>): CallVerdict {
  const { code, text, detail } = detailOf(a.body);
  const t = text.toLowerCase();
  const s = a.status ?? 0;
  if (s === 400 && t.includes('choose an org')) {
    return { kind: 'pause', reason: 'auth', message: 'treg needs a team API key, not a personal login token. Create one in treg (your team, then API keys) and save it in Settings.' };
  }
  if (s === 401 || (s === 403 && !code && KEY_REFUSALS.test(t))) {
    return { kind: 'pause', reason: 'auth', message: `treg rejected the key${text ? ` (${text})` : ''}. Check it in Settings, then Resume.` };
  }
  switch (code) {
    case 'insufficient_balance': return { kind: 'pause', reason: 'balance', message: balanceMessage(detail) };
    case 'route_max_cost': return { kind: 'row_skip', message: 'Over the per-row budget' };
    case 'share_busy': {
      const sec = typeof detail?.retry_after_s === 'number' ? detail.retry_after_s : a.retryAfterSec;
      const ms = Math.min(ENRICH_SHARE_BUSY_MAX_MS, Math.max(ENRICH_SHARE_BUSY_MIN_MS, (sec ?? 0) * 1000));
      const name = typeof detail?.provider === 'string' ? detail.provider : 'this provider';
      return {
        kind: 'retry', afterMs: ms, counts: 'busy',
        message: `treg's shared key for ${name} stayed busy (429, not charged). Rerun the row later, or connect `
          + 'your own key at treg.',
      };
    }
    case 'trial_allowance_reached': return { kind: 'row_skip', message: 'This provider is a free trial at treg with a daily allowance. Connect your own key at treg or pick another provider.' };
    case 'daily_cap_reached':
    case 'platform_daily_cap_reached':
      return { kind: 'pause', reason: 'treg_cap', message: "Your treg team's daily cap is reached (set at treg, Team settings). It isn't Cubex's daily limit." };
    case 'capability_pinned':
      return { kind: 'pause', reason: 'team_rule', message: `Your treg team only allows ${String(detail?.pinned_provider ?? 'one provider')} for this job. Change it at treg or pick that provider.` };
    case 'authorization_required': return { kind: 'pause', reason: 'team_rule', message: 'This tool needs a connected account at treg.' };
    case 'credential_missing': return { kind: 'pause', reason: 'team_rule', message: "This tool needs your own provider key at treg (treg can't serve it on its own key)." };
    case 'provider_capacity_unavailable':
      return { kind: 'pause', reason: 'provider_busy', message: `treg's own account for ${String(detail?.provider ?? 'this provider')} is out right now. Resume later, or connect your own key at treg.` };
    case 'catalog_parameter_invalid': return { kind: 'row_fail', message: text || 'treg refused these inputs.' };
    case 'identity_incomplete': return { kind: 'row_skip', message: 'Missing inputs' };
    case 'no_route_candidate': return { kind: 'row_skip', message: text || 'No provider can take these inputs' };
    case 'response_buffer_limit': return { kind: 'row_fail', message: 'The answer is over treg\'s 8 MB limit (not charged).' };
    case 'route_failed': {
      // Every provider busy or down and nothing charged: asked again under the same key.
      const f = routeFailure(detail, names);
      if (f.temporary && f.rateLimited && left.rateLimit) return { kind: 'retry', afterMs: 0, counts: 'rate_limit' };
      if (f.temporary && !f.rateLimited && left.provider) {
        return { kind: 'retry', afterMs: ENRICH_RETRY_MS, counts: 'provider' };
      }
      return { kind: 'row_fail', message: f.message };
    }
    // The provider says the target doesn't exist (a scraped page's 404): an answer, not a fault.
    case 'route_not_found': return { kind: 'row_skip', message: 'Not found' };
    case 'route_caller_fault': return { kind: 'row_fail', message: text || 'The provider rejected this request.' };
    case 'catalog_retired': return { kind: 'fail_run', message: `treg retired this tool.${text ? ` ${text}` : ''}` };
    case 'catalog_price_invalid': return { kind: 'fail_run', message: "treg can't price this tool right now." };
    case 'idempotency_response_lost':
    case 'idempotency_response_too_large':
    case 'idempotency_outcome_unknown':
      return { kind: 'row_fail', message: 'treg lost this answer after charging for it. Rerun the row.' };
  }
  if (s === 402) return { kind: 'pause', reason: 'balance', message: balanceMessage(detail) };
  if (s === 429) return { kind: 'pause', reason: 'treg_cap', message: `treg's limits stopped the run${text ? `: ${text}` : '.'}` };
  if (s === 409) return { kind: 'retry', afterMs: ENRICH_RETRY_MS, counts: 'in_progress' };
  if (s === 422 && t.includes('idempotency')) return { kind: 'retry_new_attempt', message: text };
  if (s === 403) return { kind: 'pause', reason: 'team_rule', message: `treg refused this tool for your key${text ? ` (${text})` : ''}.` };
  // credential_missing arrives as a plain multi-line string (resolve.py
  // _marketplace_no_credential): "no <service> credential in this org — …".
  const noCred = /no (\S+) credential in this org/i.exec(text);
  if (s === 404 && noCred) {
    return { kind: 'pause', reason: 'team_rule', message: `This tool needs your own ${noCred[1]} key at treg (treg can't serve it on its own key).` };
  }
  if (s === 404) return { kind: 'fail_run', message: "This tool isn't in treg's catalog anymore." };
  if (s === 410) return { kind: 'fail_run', message: `treg retired this tool.${text ? ` ${text}` : ''}` };
  if (s >= 500) return { kind: 'retry', afterMs: ENRICH_RETRY_MS, counts: 'unreachable' };
  return { kind: 'row_fail', message: text || `treg answered ${s}.` };
}

// names: provider ids -> the names the run shows, for a waterfall's failure message.
export function classifyCall(
  a: CallAnswer, retriesLeft: boolean | RetriesLeft, names: Record<string, string> = {},
): CallVerdict {
  const left = typeof retriesLeft === 'boolean' ? { provider: retriesLeft, rateLimit: retriesLeft } : retriesLeft;
  if (a.status === null) return { kind: 'retry', afterMs: ENRICH_UNREACHABLE_RETRY_MS, counts: 'unreachable' };
  // Saturation: top-level body flag, no X-Treg-Error header.
  if (a.status === 503 && isObj(a.body) && a.body.treg_saturated === true) {
    const ms = Math.max(1, a.retryAfterSec ?? 2) * 1000;
    return { kind: 'retry', afterMs: Math.min(ms, ENRICH_SATURATION_MAX_MS), counts: 'saturation' };
  }
  if (a.tregError) return tregRefusal(a, left, names);
  if (a.status >= 200 && a.status < 300) return { kind: 'ok' };
  // A 5xx with neither a call id nor treg's header never reached treg's code.
  if (a.status >= 500 && !a.callId) return { kind: 'retry', afterMs: ENRICH_UNREACHABLE_RETRY_MS, counts: 'unreachable' };
  if (a.status === 429 && left.rateLimit) {
    return { kind: 'retry', afterMs: (a.retryAfterSec ?? 0) * 1000, counts: 'rate_limit' };
  }
  if (a.status >= 500 && left.provider) return { kind: 'retry', afterMs: ENRICH_RETRY_MS, counts: 'provider' };
  const text = providerText(a.body);
  return { kind: 'row_fail', message: `The provider answered ${a.status}${text ? `: ${text.slice(0, 200)}` : ''}.` };
}

// How long a row waits before asking again after its `tries`-th 429: doubling
// from the first wait, half of it random, never under the provider's
// Retry-After, never over the most.
export function rateLimitWaitMs(tries: number, retryAfterMs: number, random: () => number = Math.random): number {
  const d = Math.min(ENRICH_PROVIDER_RATE_RETRY_MAX_MS, ENRICH_PROVIDER_RATE_RETRY_MS * 2 ** tries);
  return Math.min(ENRICH_PROVIDER_RATE_RETRY_MAX_MS, Math.max(retryAfterMs, Math.round(d / 2 + random() * d / 2)));
}
