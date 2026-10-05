import { request, Agent } from 'undici';
import { HTTP_REQUEST_TIMEOUT_MS, HTTP_MIN_TIMEOUT_MS, HTTP_MAX_TIMEOUT_MS } from './constants';
import { getCachedResponse, setCachedResponse } from './http-request-cache';
import { checkOutboundUrl, pinnedLookup } from './outbound-guard';
import {
  replaceTemplateVariables, redactedRequestConfig,
  type HTTPRequestConfig, type ResponseMapping, type HTTPAPIConfig,
} from './http-request-template';

export type { HTTPRequestConfig, ResponseMapping, HTTPAPIConfig };
export { replaceTemplateVariables, redactedRequestConfig };

// Cap on response body size from a single HTTP API request. Anything larger is rejected
// — a public endpoint that returns 100MB would otherwise be buffered into memory and
// written to http_results. 5MB default is generous for typical enrichment responses
// (Apollo/Hunter return ~10-50KB).
const HTTP_MAX_RESPONSE_BYTES = parseInt(
  process.env.HTTP_MAX_RESPONSE_BYTES || String(5 * 1024 * 1024), 10,
);

// Typed outbound errors live in the dependency-free lib/http-errors.ts. Imported
// for use below and re-exported so existing importers see them here too.
import { OutboundBlockedError } from './http-errors';
export { OutboundBlockedError };

// JSON-only response validation (and the NonJsonResponseError it throws) lives in
// the neutral lib/http-response-json.ts. Re-exported so existing importers see it
// here too.
import { parseJsonResponse, NonJsonResponseError } from './http-response-json';
export { parseJsonResponse, NonJsonResponseError };

// Secret redaction moved to lib/redact.ts (one home, no dependency on the
// request-making code). Imported for internal use here (the error-snippet
// redaction below) and re-exported so existing importers are unaffected.
import { redactSecrets, redactError } from './redact';
export { redactSecrets, redactError };

// JSONPath extraction now lives in the neutral lib/jsonpath-extract.ts so the
// webhook receiver can reuse it without importing this module's outbound-HTTP
// machinery. Re-exported here so existing importers (http-runs, services/http-row)
// are unaffected.
import { extractDataWithJSONPath } from './jsonpath-extract';
export { extractDataWithJSONPath };

// Response-body reading/bounding lives in lib/http-body-read.ts (one
// responsibility per file).
import { readBoundedBody, readErrorSnippet } from './http-body-read';

// Make an HTTP request based on config + row context. Caches identical requests for 5 min.
// allowSavedKeys carries the run-level secret policy (http_runs.allow_secrets,
// migration 034) into template substitution — see replaceTemplateVariables.
// It may be a boolean OR a resolver evaluated at the substitution point. The
// resolver form (the run worker) re-reads the policy here, then substitutes
// using the captured value with no further DB read — so a mid-run no-'secrets'
// resume-freeze (allow_secrets→0) is honored at per-row granularity even though
// the freeze commits from another thread's connection. See the inline note.
export async function makeHTTPRequest(
  config: HTTPRequestConfig,
  rowData: Record<string, string>,
  userId: string,
  signal?: AbortSignal,
  allowSavedKeys = true,
  runId?: string,
): Promise<any> {
  // allowSavedKeys is the start-time-frozen fast pre-filter; runId makes each
  // key lookup re-check allow_secrets atomically (closing the resume-freeze
  // TOCTOU — see replaceTemplateVariables / lookupApiKey).
  const sub = (t: string) => replaceTemplateVariables(t, rowData, userId, 'live', allowSavedKeys, runId);
  const processedUrl = sub(config.url);

  const processedHeaders: Record<string, string> = {};
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      const name = sub(key);
      // A templated name can come out empty or invalid for a row; say which header
      // (its template, never the substituted text, which may hold a saved key).
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new Error(`Header name "${key}" is empty or not a valid header name for this row.`);
      }
      processedHeaders[name] = sub(value);
    }
  }
  const processedBody = config.body ? sub(config.body) : undefined;

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
  if (processedBody && ['POST', 'PUT'].includes(config.method)) requestOptions.body = processedBody;

  const response = await request(processedUrl, requestOptions);

  // Non-2xx → throw, so the runner records the row as failed (with status context).
  // Without this, a 401/429/500 from the user's target API silently went into the row
  // as if it were successful.
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const snippet = await readErrorSnippet(response.body);
    throw new Error(`HTTP ${response.statusCode} from upstream${snippet ? `: ${snippet}` : ''}`);
  }

  // Reject early if the server advertises a response larger than our cap.
  const contentLengthHeader = response.headers['content-length'];
  if (contentLengthHeader) {
    const declaredLength = parseInt(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > HTTP_MAX_RESPONSE_BYTES) {
      response.body.destroy(new Error('Response too large'));
      throw new Error(
        `Response exceeds the ${(HTTP_MAX_RESPONSE_BYTES / 1024 / 1024).toFixed(0)}MB cap ` +
        `(server advertised ${declaredLength} bytes). Increase HTTP_MAX_RESPONSE_BYTES if needed.`,
      );
    }
  }

  const bodyText = await readBoundedBody(response.body, HTTP_MAX_RESPONSE_BYTES);

  // JSON-only: parse-required, reject HTML/XML pages. This both fits the
  // JSONPath-extraction feature and stops the HTTP API being used to scrape web
  // pages through Cubex's shared egress IP. Throws NonJsonResponseError (typed) on
  // a non-JSON / unparseable body; the runner records it as a clean per-row error.
  // undici can hand back a duplicated upstream Content-Type as string[] — JOIN
  // (don't pick [0]) so parseJsonResponse sees EVERY value: a later `text/html`
  // duplicate must still be caught by the explicit page-type reject, not dropped.
  const ctHeader = response.headers['content-type'];
  const contentType = Array.isArray(ctHeader) ? ctHeader.join(', ') : ctHeader;
  const responseData = parseJsonResponse(bodyText, contentType);

  // Only store idempotent (GET/HEAD) responses — never cache a POST/PUT/etc result
  // (a later identical request must re-run its side effect, not read a cache hit).
  if (cacheable) setCachedResponse(cacheKey, responseData, bodyText.length);
  return responseData;

  } finally {
    // The Agent is per-request (its DNS pinning is per-URL), so close it on
    // every exit path — otherwise each row leaks a socket pool until GC.
    // Body is fully consumed (or destroyed) by now; fire-and-forget is fine.
    dispatcher.close().catch(() => {});
  }
}
