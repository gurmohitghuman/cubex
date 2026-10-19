// A token's spend cap, worked out (services/token-spend.ts reads the numbers).
// What a token's runs spent is the usage history's own figures (OpenRouter's
// charge, the user's own provider key, treg's charges) and stays spent: the
// cap is for the token's whole life, never a month, so going on past it takes
// a higher cap or a new token.
import { DEFAULT_AI_CONCURRENCY, MAX_AI_CONCURRENCY, PREVIEW_MAX_ROWS } from './constants-ai';
import { MAX_TOKEN_SPEND_CAP_USD, WORKER_POOL_SIZE } from './constants';
import { MAX_ACTIVE_PREVIEWS_PER_USER } from './ai-preview-concurrency';

const EPS = 1e-9;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
export const usd = (v: number): string => `$${v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4)}`;

// What every surface shows for a token: the cap (null: none), spent, and left (null: no cap).
export interface SpendView { spend_cap_usd: number | null; spent_usd: number; left_usd: number | null }

export function spendView(capMicro: number | null, spentUsd: number): SpendView {
  const cap = capMicro === null ? null : capMicro / 1e6;
  return {
    spend_cap_usd: cap,
    spent_usd: round6(spentUsd),
    left_usd: cap === null ? null : round6(Math.max(0, cap - spentUsd)),
  };
}

export const capReached = (capUsd: number | null, spentUsd: number): boolean =>
  capUsd !== null && spentUsd + EPS >= capUsd;

export const LIFETIME_NOTE = "The cap is for the token's whole life, not a month: raise it in Settings → "
  + 'Agent access, or make a new token.';

// A revoked token's cap can't be raised (Settings lists live tokens only): the app takes its runs over.
const REVOKED_NOTE = "The token was revoked, so its cap can't be raised: resume the run from the app, which takes "
  + 'it over (what it spends from then on counts against no token), or run the column again there.';
export interface CapOf { name: string; capUsd: number; spentUsd: number; revoked: boolean }

export const capReachedMessage = (t: CapOf): string => `The access token "${t.name}" reached its `
  + `${usd(t.capUsd)} spend cap (${usd(t.spentUsd)} spent). ${t.revoked ? REVOKED_NOTE : LIFETIME_NOTE}`;

// A run whose rows each cost up to perRowUsd, when the token has less than that left.
export const capNoRoomMessage = (t: CapOf, perRowUsd: number): string => `The access token "${t.name}" has `
  + `${usd(Math.max(0, t.capUsd - t.spentUsd))} left of its ${usd(t.capUsd)} spend cap, too little for another `
  + `row at up to ${usd(perRowUsd)}. ${t.revoked ? REVOKED_NOTE : LIFETIME_NOTE}`;

// How far past its cap a token can go: the calls already out when it gets there.
export const OVERSHOOT_NOTE = 'At the cap, new AI and enrichment runs, previews and AI helpers are refused, and '
  + 'running ones pause (resume them once the cap is raised; an auto-run goes on by itself). HTTP API runs cost '
  + 'nothing here and go on. Calls already in flight finish and count, so spend can pass the cap by those alone: '
  + `an AI run has up to its concurrency of rows out at once (default ${DEFAULT_AI_CONCURRENCY}, at most `
  + `${MAX_AI_CONCURRENCY}) and up to ${WORKER_POOL_SIZE} runs work at once; a preview runs up to ${PREVIEW_MAX_ROWS} `
  + `rows, at most ${MAX_ACTIVE_PREVIEWS_PER_USER} previews at once; each AI helper makes one or two small calls. An `
  + 'enrichment or waterfall run first holds room for its rows at their per-row cap, so it stops before the cap '
  + '(one with no per-row cap stops once what was billed reaches it).';

// What the agent-facing tools say (nothing without a cap): the cap and what
// was left when the tool list was made. full: also what happens at the cap
// and how far past it spend can go (the tools that start paid runs).
export function capToolNote(view: SpendView | null, full: boolean): string {
  if (!view || view.spend_cap_usd === null) return '';
  const line = ` SPEND CAP: this access token may spend ${usd(view.spend_cap_usd)} in all on AI and enrichments `
    + `(for its whole life, not per month); ${usd(view.left_usd ?? 0)} was left when this tool list was loaded `
    + '(get_balances says what is left now).';
  return full ? `${line} ${OVERSHOOT_NOTE}` : `${line} At the cap this is refused.`;
}

// A cap typed in Settings: dollars, 0 up to MAX_TOKEN_SPEND_CAP_USD, or null/'' for none. Kept in micro-USD.
export function parseSpendCap(raw: unknown): { micro: number | null } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { micro: null };
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_TOKEN_SPEND_CAP_USD) {
    const most = MAX_TOKEN_SPEND_CAP_USD.toLocaleString('en-US');
    return { error: `The spend cap must be a dollar amount from 0 to ${most}, `
      + 'or empty for no cap.' };
  }
  return { micro: Math.round(n * 1e6) };
}
