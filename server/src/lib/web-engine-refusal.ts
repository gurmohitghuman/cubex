// A run with web fetch limits sends the fetch tool with engine "exa"
// (lib/ai-web-tools.ts). OpenRouter refuses a request whose engine a workspace
// admin's engine list on the Server Tools page doesn't allow with a 403
// (https://openrouter.ai/docs/guides/features/server-tools/web-fetch, "Workspace
// Settings"). Every row would fail the same way, so the run pauses once instead
// ('web_engine', lib/run-pool.ts) and the rows stay waiting for a resume.
//
// OpenRouter documents the status and its error shape ({ error: { code,
// message, metadata } }: https://openrouter.ai/docs/api/reference/errors-and-debugging),
// not this refusal's words, and they weren't seen on a live call. So the match
// is narrow, kept here alone so a different live answer only changes this file:
// a 403 whose message, or a metadata field named for an engine or a tool,
// names an engine together with web fetch, server tools or Exa. Moderation
// (its metadata carries the flagged input, the user's own words), guardrail,
// budget and key refusals don't match, and a 403 this doesn't recognise fails
// its row with OpenRouter's own words, as before.
import { redactSecrets } from './redact';
import { hasFetchLimits, runFetchLimits } from './web-fetch-options';

const ENGINE = /\bengines?\b/i;
const FETCH = /web[\s_-]?fetch|server[\s_-]?tools?|\bexa\b/i;
const NAMED_FIELD = /engine|tool/i;

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

// OpenRouter's words when the error is this refusal; null otherwise.
export function webEngineRefusalWords(error: unknown): string | null {
  const e = error as { status?: unknown; message?: unknown; error?: unknown } | null;
  if (!e || e.status !== 403) return null;
  const body = e.error && typeof e.error === 'object' ? e.error as { message?: unknown; metadata?: unknown } : {};
  const meta = body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : {};
  if ('flagged_input' in meta) return null;
  const message = typeof body.message === 'string' ? body.message : text(e.message);
  const fields = Object.entries(meta).filter(([k]) => NAMED_FIELD.test(k)).map(([k, v]) => `${k}: ${text(v)}`);
  const all = [message, ...fields].join(' ');
  return ENGINE.test(all) && FETCH.test(all) ? redactSecrets(all).slice(0, 200) : null;
}

// The refusal as a run with fetch limits meets it (a run without them sends no engine, so a 403 fails its row as
// before); null when it isn't one.
type FetchRun = {
  use_web_fetch?: number | null; web_fetch_max_content_tokens?: number | null; web_fetch_max_pages?: number | null;
};
export function webEngineRefusal(run: FetchRun, error: unknown): string | null {
  return run.use_web_fetch && hasFetchLimits(runFetchLimits(run)) ? webEngineRefusalWords(error) : null;
}

// Why the run paused (never starting with "Paused": the grid's toast adds that).
export const webEngineMessage = (words: string): string => ('OpenRouter refused the web fetch engine Exa (403): '
  + 'your workspace limits web fetch engines on its Server Tools page and Exa isn\'t allowed. Runs with a tokens '
  + 'per page or pages per row limit read pages through Exa. Allow Exa there, then resume this run, or run the '
  + `column again without the two limits. OpenRouter said: ${words}`).slice(0, 500);
