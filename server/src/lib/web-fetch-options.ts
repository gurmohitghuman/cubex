// The web fetch limits of a run request (run_ai_column, POST /v1/sheets/:id/ai-runs and the app's run settings),
// checked in one place so every surface takes the same values and refuses with the same words. Each is a whole
// number, or digits sent as text; null when not given. They need web_fetch, so a limit never silently does
// nothing. Sent to OpenRouter's web fetch tool by lib/ai-web-tools.ts.
import { promptHash } from './ai-prompt-hash';
import {
  WEB_FETCH_MAX_CONTENT_TOKENS_MIN, WEB_FETCH_MAX_CONTENT_TOKENS_MAX, WEB_FETCH_MAX_PAGES_PER_ROW,
} from './constants-ai';

export interface FetchLimits {
  maxContentTokens: number | null;   // per fetched page (OpenRouter's max_content_tokens)
  maxPagesPerRow: number | null;     // pages a row may fetch (OpenRouter's max_uses)
}

export const NO_FETCH_LIMITS: FetchLimits = { maxContentTokens: null, maxPagesPerRow: null };

export const MAX_CONTENT_TOKENS_RANGE = `a whole number from ${WEB_FETCH_MAX_CONTENT_TOKENS_MIN} to `
  + `${WEB_FETCH_MAX_CONTENT_TOKENS_MAX.toLocaleString('en-US')}`;
export const MAX_PAGES_RANGE = `a whole number from 1 to ${WEB_FETCH_MAX_PAGES_PER_ROW}`;

const given = (v: unknown) => v !== undefined && v !== null && v !== '';

function wholeIn(v: unknown, min: number, max: number): number | null | 'invalid' {
  if (!given(v)) return null;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : 'invalid';
}

export function parseFetchLimits(
  raw: { maxContentTokens?: unknown; maxPagesPerRow?: unknown }, webFetch: boolean,
): { ok: FetchLimits } | { error: string } {
  if (!webFetch && (given(raw.maxContentTokens) || given(raw.maxPagesPerRow))) {
    return { error: 'max_content_tokens and max_pages_per_row need web_fetch turned on.' };
  }
  const tokens = wholeIn(raw.maxContentTokens, WEB_FETCH_MAX_CONTENT_TOKENS_MIN, WEB_FETCH_MAX_CONTENT_TOKENS_MAX);
  const pages = wholeIn(raw.maxPagesPerRow, 1, WEB_FETCH_MAX_PAGES_PER_ROW);
  // Both named at once when both are wrong, so one corrected call goes through.
  const wrong = [
    ...(tokens === 'invalid' ? [`max_content_tokens must be ${MAX_CONTENT_TOKENS_RANGE}.`] : []),
    ...(pages === 'invalid' ? [`max_pages_per_row must be ${MAX_PAGES_RANGE}.`] : []),
  ];
  if (tokens === 'invalid' || pages === 'invalid') return { error: wrong.join(' ') };
  return { ok: { maxContentTokens: tokens, maxPagesPerRow: pages } };
}

export const hasFetchLimits = (l: FetchLimits | null | undefined): boolean =>
  !!l && (l.maxContentTokens !== null || l.maxPagesPerRow !== null);

// A stored run's limits (ai_runs.web_fetch_*, migration 055).
export const runFetchLimits = (run: {
  web_fetch_max_content_tokens?: number | null; web_fetch_max_pages?: number | null;
}): FetchLimits => ({
  maxContentTokens: run.web_fetch_max_content_tokens ?? null, maxPagesPerRow: run.web_fetch_max_pages ?? null,
});

// The last three ai_runs values every start and rerun inserts (migration 055): the prompt's hash, then the fetch
// limits (none without web fetch).
export const runInsertExtras = (prompt: string, webFetch: boolean, limits?: FetchLimits | null) => [
  promptHash(prompt),
  webFetch ? limits?.maxContentTokens ?? null : null,
  webFetch ? limits?.maxPagesPerRow ?? null : null,
] as const;
