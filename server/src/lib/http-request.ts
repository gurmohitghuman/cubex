import { request, Agent } from 'undici';
import { HTTP_REQUEST_TIMEOUT_MS, HTTP_MIN_TIMEOUT_MS, HTTP_MAX_TIMEOUT_MS } from './constants';
import { getCachedResponse, setCachedResponse } from './http-request-cache';
import { checkOutboundUrl, pinnedLookup } from './outbound-guard';
import {
  replaceTemplateVariables,
  type HTTPRequestConfig, type ResponseMapping, type HTTPAPIConfig,
} from './http-request-template';
import { buildRequest, redactedRequestConfig } from './http-request-build';

export type { HTTPRequestConfig, ResponseMapping, HTTPAPIConfig };
export { replaceTemplateVariables, redactedRequestConfig };

// Cap on response body size from a single HTTP API request. Anything larger is rejected
// — a public endpoint that returns 100MB would otherwise be buffered into memory and
// written to http_results. 5MB default is generous for typical enrichment responses
// (Apollo/Hunter return ~10-50KB).
const HTTP_MAX_RESPONSE_BYTES = parseInt(
  process.env.HTTP_MAX_RESPONSE_BYTES || String(5 * 1024 * 1024), 10,
);

// Typed outbound errors live in the dependency-free lib/http-errors.ts.
import {
  NetworkError, OutboundBlockedError, UpstreamStatusError, isTransportFailure, withResponseStatus,
} from './http-errors';
import { goneColumnsOf } from './template-token-match';
export { OutboundBlockedError };

// JSON-only response validation lives in the neutral lib/http-response-json.ts.
import { parseJsonResponse, NonJsonResponseError } from './http-response-json';
export { parseJsonResponse, NonJsonResponseError };

// Secret redaction lives in lib/redact.ts; re-exported for existing importers.
import { redactSecrets, redactError } from './redact';
export { redactSecrets, redactError };

// JSONPath extraction lives in the neutral lib/jsonpath-extract.ts (the webhook
// receiver reuses it without this module's outbound machinery).
import { extractDataWithJSONPath } from './jsonpath-extract';
export { extractDataWithJSONPath };

// Response-body reading/bounding lives in lib/http-body-read.ts (one
// responsibility per file).
import { readBoundedBody, readErrorSnippet } from './http-body-read';

// One try of a row's request: its parsed JSON body and status code. Caches
// identical GET/HEAD answers for 5 min. allowSavedKeys carries the run-level
// secret policy (http_runs.allow_secrets) into template substitution; runId
// makes each key lookup re-check it atomically (closing the resume-freeze
// TOCTOU — see replaceTemplateVariables / lookupApiKey). Throws typed errors
// (lib/http-errors.ts) so the runner can tell what a retry could change.
// Every try goes cache check → SSRF guard → request; retries (lib/http-retry.ts)
// call this again from the top.
export async function sendHTTPRequest(
  config: HTTPRequestConfig,
  rowData: Record<string, string>,
  userId: string,
  signal?: AbortSignal,
  allowSavedKeys = true,
  runId?: string,
): Promise<{ data: any; status: number }> {
  const { url: processedUrl, headers: processedHeaders, body: processedBody } = buildRequest(config, {
    rowData, userId, mode: 'live', allowSavedKeys, runId, gone: goneColumnsOf(config),
  });

  // Nudge upstreams toward JSON when the user didn't set an Accept header — a
  // content-negotiating server returns JSON instead of an HTML page, which both
  // helps honest JSON APIs and reduces accidental NonJsonResponseError rejections.
  // Case-insensitive presence check so we never clobber a user-supplied Accept.
  if (!Object.keys(processedHeaders).some(h => h.toLowerCase() === 'accept')) {
    processedHeaders['Accept'] = 'application/json';
  }

  // Only IDEMPOTENT methods are cacheable. Re-issuing a POST/PUT/PATCH/DELETE has
  // side effects (creates a record, sends a message, charges a card), so serving a
  // cached response would SKIP the real call and write a stale result. Caching GET
  // (and HEAD) is safe and is where enrichment lookups live. A non-idempotent
  // request always hits the network. (method is upper-cased by the config shape.)
  const method = (config.method || 'GET').toUpperCase();
  const cacheable = method === 'GET' || method === 'HEAD';

  // Canonical cache key, scoped by userId like every other read. Headers are SORTED so the same logical request with headers
  // in a different insertion order produces the SAME key (else a cache miss → a
  // redundant upstream call + re-bill).
  const canonicalHeaders = Object.fromEntries(
    Object.entries(processedHeaders).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const cacheKey = JSON.stringify({ userId, method, url: processedUrl, headers: canonicalHeaders, body: processedBody });
  if (cacheable) {
    const cached = getCachedResponse(cacheKey);
    if (cached !== null) return cached;
  }

  // SSRF guard runs per-row because /column substitutions may resolve to different
  // hostnames in different rows. Runs AFTER the cache check, so a cached hit
  // doesn't pay for the DNS resolution.
  const guard = await checkOutboundUrl(processedUrl);
  if (!guard.ok) throw new OutboundBlockedError(guard.reason || 'URL not allowed');

  // Pin DNS to IPs already validated in checkOutboundUrl — prevents DNS rebinding,
  // where an attacker's domain could return a public IP during the guard and a
  // private IP during the actual fetch.
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(guard.addresses || []) } });
  try {

  // undici has no `timeout` option — the old code passed one and undici
  // silently IGNORED it, leaving the 300s defaults (a slow upstream stalled
  // each row for up to 5 minutes). headersTimeout bounds time-to-first-byte;
  // bodyTimeout bounds gaps between body chunks (total size is bounded by
  // HTTP_MAX_RESPONSE_BYTES below). config.timeout is client-supplied — clamp.
  const rawTimeout = typeof config.timeout === 'number' && Number.isFinite(config.timeout)
    ? config.timeout : HTTP_REQUEST_TIMEOUT_MS;
  const timeoutMs = Math.max(HTTP_MIN_TIMEOUT_MS, Math.min(rawTimeout, HTTP_MAX_TIMEOUT_MS));

  const requestOptions: any = {
    method: config.method,
    headers: processedHeaders,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    dispatcher,
  };
  if (signal) requestOptions.signal = signal;
  // DELETE carries a body too: the dialog offers one and some APIs (bulk deletes) read it.
  if (processedBody && ['POST', 'PUT', 'DELETE'].includes(config.method)) requestOptions.body = processedBody;

  // No answer at all (refused, reset, timed out) is a NetworkError, which a
  // retry may fix; a stop (the signal) stays an abort, and an error raised
  // before anything was sent (a header with a line break) stays as it is.
  // undici never follows a redirect here: a 3xx is an answer like any other.
  const noAnswer = (error: any): never => {
    if (signal?.aborted || error?.name === 'AbortError' || !isTransportFailure(error)) throw error;
    throw new NetworkError(error?.message || 'The request failed.');
  };
  const response = await request(processedUrl, requestOptions).catch(noAnswer);
  const status = response.statusCode;

  // Non-2xx → throw, so the runner records the row as failed (with status context).
  // Without this, a 401/429/500 from the user's target API silently went into the row
  // as if it were successful.
  if (status < 200 || status >= 300) {
    const snippet = await readErrorSnippet(response.body);
    const after = response.headers['retry-after'];
    throw new UpstreamStatusError(status, (Array.isArray(after) ? after[0] : after) ?? null,
      `HTTP ${status} from upstream${snippet ? `: ${snippet}` : ''}`);
  }

  // Reject early if the server advertises a response larger than our cap.
  const contentLengthHeader = response.headers['content-length'];
  if (contentLengthHeader) {
    const declaredLength = parseInt(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > HTTP_MAX_RESPONSE_BYTES) {
      response.body.destroy(new Error('Response too large'));
      throw withResponseStatus(new Error(
        `Response exceeds the ${(HTTP_MAX_RESPONSE_BYTES / 1024 / 1024).toFixed(0)}MB cap ` +
        `(server advertised ${declaredLength} bytes). Increase HTTP_MAX_RESPONSE_BYTES if needed.`,
      ), status);
    }
  }

  // The cap is ours (not retried); anything else mid-body is the connection.
  const bodyText = await readBoundedBody(response.body, HTTP_MAX_RESPONSE_BYTES).catch((error: any) => {
    if (/^Response exceeds the/.test(error?.message ?? '')) throw withResponseStatus(error, status);
    return noAnswer(error);
  });

  // JSON-only: parse-required, reject HTML/XML pages. This both fits the
  // JSONPath-extraction feature and stops the HTTP API being used to scrape web
  // pages through Cubex's shared egress IP. Throws NonJsonResponseError (typed) on
  // a non-JSON / unparseable body; the runner records it as a clean per-row error.
  // undici can hand back a duplicated upstream Content-Type as string[] — JOIN
  // (don't pick [0]) so parseJsonResponse sees EVERY value: a later `text/html`
  // duplicate must still be caught by the explicit page-type reject, not dropped.
  const ctHeader = response.headers['content-type'];
  const contentType = Array.isArray(ctHeader) ? ctHeader.join(', ') : ctHeader;
  let responseData: any;
  try { responseData = parseJsonResponse(bodyText, contentType); }
  catch (error) { throw withResponseStatus(error, status); }

  // Only store idempotent (GET/HEAD) responses — never cache a POST/PUT/etc result
  // (a later identical request must re-run its side effect, not read a cache hit).
  const answer = { data: responseData, status };
  if (cacheable) setCachedResponse(cacheKey, answer, bodyText.length);
  return answer;

  } finally {
    // The Agent is per-request (its DNS pinning is per-URL), so close it on
    // every exit path — otherwise each row leaks a socket pool until GC.
    // Body is fully consumed (or destroyed) by now; fire-and-forget is fine.
    dispatcher.close().catch(() => {});
  }
}

// One try, body only (the preview and older callers).
export async function makeHTTPRequest(
  config: HTTPRequestConfig, rowData: Record<string, string>, userId: string,
  signal?: AbortSignal, allowSavedKeys = true, runId?: string,
): Promise<any> {
  return (await sendHTTPRequest(config, rowData, userId, signal, allowSavedKeys, runId)).data;
}
