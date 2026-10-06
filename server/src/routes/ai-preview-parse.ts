import { MAX_AI_CONCURRENCY } from '../lib/constants';
import { sanitizeAndValidateColumnName } from '../lib/column-names';
import { validateModelParam } from '../lib/ai-model-resolve';
import type { SearchOptions } from '../lib/web-search-options';
import { parseWebOptions } from './ai-run-parse';

// Parse + validate + numeric-bound the /ai/preview request body. Split out of
// ai-preview.ts (200-line guardrail) — a self-contained "trust the client's
// body as little as possible" step. Returns a 400 {status, error} on any
// rejection, or {ok, ...safeFields} with everything bounded and the column name
// canonicalized (same relaxed validation as /ai/run, so a preview that succeeds
// can't fail at run/commit).

export interface PreviewParseError { ok: false; status: number; error: string; }
export interface PreviewParams {
  ok: true;
  sheetId: string;
  cleanColumnName: string;
  prompt: string;
  systemPrompt: string | undefined;
  // Optional here — resolution against sheet/account defaults happens in the
  // route (needs DB access). No hardcoded fallback (see lib/ai-model-resolve).
  model: string | undefined;
  useOpenRouterWebSearch: boolean;
  useWebFetch: boolean;
  safePreviewSize: number;
  safeTemperature: number;
  safeConcurrency: number;
  safeMaxChars: number | null;
  search: SearchOptions | null;
}

// User-facing message for a pre-stream preview failure (validation, client
// setup, row reads — processOneRow returns per-row errors and never throws).
export function previewErrorMessage(error: any): string {
  const msg = error?.message || '';
  if (msg.includes('Invalid OpenRouter API key')) return 'Invalid OpenRouter API key. Please check your settings.';
  if (msg.includes('rate limit')) return 'Rate limit exceeded. Please try again in a few minutes.';
  if (msg.includes('quota')) return 'API quota exceeded. Please check your OpenRouter account.';
  if (msg.includes('model')) return 'Invalid model specified. Please check your configuration.';
  return 'Failed to generate preview';
}

export function parsePreviewRequest(body: any): PreviewParams | PreviewParseError {
  const {
    sheetId, columnName, prompt, systemPrompt,
    model, temperature = 0.7,
    maxChars, previewSize = 5,
    // Not used by the preview itself — captured into the draft so hydration
    // restores the user's slider. Excluded from the config hash.
    concurrency = 5,
  } = body ?? {};

  if (!sheetId || !columnName || !prompt) {
    return { ok: false, status: 400, error: 'Sheet ID, column name, and prompt are required' };
  }
  if (typeof prompt !== 'string') return { ok: false, status: 400, error: 'Prompt must be a string.' };
  const modelParamError = validateModelParam(model);
  if (modelParamError) return { ok: false, status: 400, error: modelParamError };
  const web = parseWebOptions(body);
  if ('error' in web) return { ok: false, status: 400, error: web.error };

  const nameCheck = sanitizeAndValidateColumnName(columnName);
  if ('error' in nameCheck) return { ok: false, status: 400, error: nameCheck.error };

  // Bound previewSize so a malicious value doesn't trigger 999999 rows of preview
  // work. Clay's default is 5; > 20 is unhelpful UX too.
  const safePreviewSize = (typeof previewSize === 'number' && Number.isFinite(previewSize))
    ? Math.max(1, Math.min(Math.floor(previewSize), 20)) : 5;
  const safeTemperature = (typeof temperature === 'number' && Number.isFinite(temperature))
    ? Math.max(0, Math.min(temperature, 2)) : 0.7;
  // Same bounds as /ai/run — this value only rides the draft for hydration.
  const safeConcurrency = (typeof concurrency === 'number' && Number.isFinite(concurrency))
    ? Math.max(1, Math.min(Math.floor(concurrency), MAX_AI_CONCURRENCY)) : 5;
  const safeMaxChars = (typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0)
    ? Math.min(Math.floor(maxChars), 100000) : null;

  return {
    ok: true,
    sheetId, cleanColumnName: nameCheck.name, prompt, systemPrompt,
    model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
    ...web.ok,
    safePreviewSize, safeTemperature, safeConcurrency, safeMaxChars,
  };
}
