// Over 200 lines: one outbound request path (template, cache, address check, request and its redirects, bounded
// body) kept whole; which redirect to follow and with what is lib/http-redirect.ts.
import { request, Agent } from 'undici';
import { HTTP_REQUEST_TIMEOUT_MS, HTTP_MIN_TIMEOUT_MS, HTTP_MAX_TIMEOUT_MS, HTTP_TOTAL_SLACK_MS } from './constants';
import { callDeadline, deadlineWords } from './call-deadline';
import { getCachedResponse, setCachedResponse } from './http-request-cache';
import { checkOutboundUrl, pinnedLookup } from './outbound-guard';
import { HTTP_MAX_REDIRECTS, nextHop, type Hop } from './http-redirect';
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
// identical GET/HEAD answers for 5 min within one run. allowSavedKeys carries the run-level
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
  // Scoped by run too: rows of one run asking the same thing share its answer, but a run the user starts again calls
  // again instead of reading what the last run was told (within HTTP_REQUEST_CACHE_TTL_MS it got nothing new).
  const cacheKey = JSON.stringify({
    userId, runId: runId ?? null, method, url: processedUrl, headers: canonicalHeaders, body: processedBody,
  });
  if (cacheable) {
    const cached = getCachedResponse(cacheKey);
    if (cached !== null) return cached;
  }

  // SSRF guard runs per-row because /column substitutions may resolve to different
  // hostnames in different rows. Runs AFTER the cache check, so a cached hit
  // doesn't pay for the DNS resolution.
  let guard = await checkOutboundUrl(processedUrl);
  if (!guard.ok) throw new OutboundBlockedError(guard.reason || 'URL not allowed');

  // Pin DNS to IPs already validated in checkOutboundUrl — prevents DNS rebinding,
  // where an attacker's domain could return a public IP during the guard and a
  // private IP during the actual fetch.
  let dispatcher = new Agent({ connect: { lookup: pinnedLookup(guard.addresses || []) } });
  let deadline: ReturnType<typeof callDeadline> | null = null;
  try {

  // undici has no `timeout` option — the old code passed one and undici
  // silently IGNORED it, leaving the 300s defaults (a slow upstream stalled
  // each row for up to 5 minutes). headersTimeout bounds time-to-first-byte;
  // bodyTimeout bounds gaps between body chunks (total size is bounded by
  // HTTP_MAX_RESPONSE_BYTES below). config.timeout is client-supplied — clamp.
  const rawTimeout = typeof config.timeout === 'number' && Number.isFinite(config.timeout)
    ? config.timeout : HTTP_REQUEST_TIMEOUT_MS;
  const timeoutMs = Math.max(HTTP_MIN_TIMEOUT_MS, Math.min(rawTimeout, HTTP_MAX_TIMEOUT_MS));
  // The whole request ends too: bodyTimeout alone lets a server trickling bytes hold the row.
  const totalMs = timeoutMs * 2 + HTTP_TOTAL_SLACK_MS;
  deadline = callDeadline(totalMs, signal);

  // No answer at all (refused, reset, timed out) is a NetworkError, which a
  // retry may fix; a stop (the signal) stays an abort, and an error raised
  // before anything was sent (a header with a line break) stays as it is.
  const noAnswer = (error: any): never => {
    if (deadline?.timedOut()) throw new NetworkError(`No full answer within ${deadlineWords(totalMs)}.`);
    if (signal?.aborted || error?.name === 'AbortError' || !isTransportFailure(error)) throw error;
    throw new NetworkError(error?.message || 'The request failed.');
  };
  // DELETE carries a body too: the dialog offers one and some APIs (bulk deletes) read it.
  let hop: Hop = {
    url: processedUrl, method: config.method, headers: processedHeaders,
    body: processedBody && ['POST', 'PUT', 'DELETE'].includes(config.method) ? processedBody : undefined,
  };
  // undici follows no redirect itself: a 3xx this follows (lib/http-redirect.ts) goes through the full guard and a
  // pinned connection of its own, like the first request; one it doesn't follow is the answer, as any other status.
  let response: Awaited<ReturnType<typeof request>>;
  // A redirect to another host left the request's headers behind (a key among them): a refusal then says so.
  let headersLeft = false;
  for (let redirects = 0; ; redirects++) {
    const requestOptions: any = {
      method: hop.method, headers: hop.headers, headersTimeout: timeoutMs, bodyTimeout: timeoutMs, dispatcher,
      signal: deadline.signal, ...(hop.body !== undefined ? { body: hop.body } : {}),
    };
    response = await request(hop.url, requestOptions).catch(noAnswer);
    const next = nextHop(hop, response.statusCode, response.headers.location);
    if (next === null) break;
    await response.body.dump().catch(() => {});
    if ('error' in next) throw new UpstreamStatusError(response.statusCode, null, next.error);
    if (redirects >= HTTP_MAX_REDIRECTS) {
      throw new UpstreamStatusError(response.statusCode, null, `More than ${HTTP_MAX_REDIRECTS} redirects in a row.`);
    }
    guard = await checkOutboundUrl(next.ok.url);
    if (!guard.ok) throw new OutboundBlockedError(`A redirect was refused: ${guard.reason || 'URL not allowed'}`);
    dispatcher.close().catch(() => {});
    dispatcher = new Agent({ connect: { lookup: pinnedLookup(guard.addresses || []) } });
    if (Object.keys(next.ok.headers).length < Object.keys(hop.headers).length) headersLeft = true;
    hop = next.ok;
  }
  const status = response.statusCode;

  // Non-2xx → throw, so the runner records the row as failed (with status context).
  // Without this, a 401/429/500 from the user's target API silently went into the row
  // as if it were successful.
  if (status < 200 || status >= 300) {
    const snippet = await readErrorSnippet(response.body);
    const after = response.headers['retry-after'];
    throw new UpstreamStatusError(status, (Array.isArray(after) ? after[0] : after) ?? null,
      `HTTP ${status} from upstream${snippet ? `: ${snippet}` : ''}${headersLeft
        ? ' (a redirect sent the request to another host, without its headers)' : ''}`);
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
    deadline?.done();
  }
}

// One try, body only (the preview and older callers).
export async function makeHTTPRequest(
  config: HTTPRequestConfig, rowData: Record<string, string>, userId: string,
  signal?: AbortSignal, allowSavedKeys = true, runId?: string,
): Promise<any> {
  return (await sendHTTPRequest(config, rowData, userId, signal, allowSavedKeys, runId)).data;
}
