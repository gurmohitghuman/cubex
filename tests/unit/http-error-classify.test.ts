// HTTP row failures get an actionable class (an upstream 404 used to come back
// "unknown"). Messages below are the ones http-row.ts records, verbatim.

import assert from 'node:assert/strict'
import classifyMod from '../../server/src/lib/http-error-classify'
// Default import + destructure: Node 22 (CI) can't see named exports of the
// server's CommonJS modules from this ESM test file.
const { classifyHttpError: cls, summarizeHttpErrorClasses } =
  classifyMod as typeof import('../../server/src/lib/http-error-classify')

const cases: Array<[string | null, string]> = [
  ['HTTP 404 from upstream: {"error":"no such company"}', 'not_found'],
  ['HTTP 410 from upstream', 'not_found'],
  ['HTTP 429 from upstream: Too Many Requests', 'retryable'],
  ['HTTP 503 from upstream: <html>Service Unavailable</html>', 'retryable'],
  ['HTTP 408 from upstream', 'retryable'],
  ['HTTP 401 from upstream: {"message":"Invalid API key"}', 'configuration'],
  ['HTTP 403 from upstream', 'configuration'],
  ['HTTP 400 from upstream: {"error":"domain is required"}', 'configuration'],
  ['HTTP 301 from upstream', 'configuration'],
  ["{{Domian}} doesn't match a column or a saved key, so the request wasn't sent.", 'configuration'],
  ['Header name "" is empty or not a valid header name for this row.', 'configuration'],
  ['JSONPath "$.a[" (column "A"): Invalid JSONPath', 'configuration'],
  ["localhost resolves to a private/internal address (127.0.0.1). Cubex doesn't fetch internal URLs from user-supplied templates.", 'configuration'],
  ['Only http(s) URLs are allowed (got ftp:).', 'configuration'],
  ['Invalid URL.', 'configuration'],
  ['Could not resolve api.exmaple.com.', 'configuration'],
  ['URL not allowed', 'configuration'],
  ['HTTP API enrichment only supports JSON API responses. The upstream returned text/html; HTML/XML pages are not supported.', 'response_format'],
  ['HTTP API enrichment only supports valid JSON responses. The upstream returned application/json, but the body was not valid JSON.', 'response_format'],
  ['HTTP API enrichment expects a JSON object or array, but the upstream returned a single JSON number value.', 'response_format'],
  ['Response exceeds the 10MB cap (server advertised 99999999 bytes). Increase HTTP_MAX_RESPONSE_BYTES if needed.', 'response_format'],
  ['Response exceeds the 10MB cap.', 'response_format'],
  ['HTTP 501 from upstream', 'configuration'],
  ['connect EHOSTUNREACH 203.0.113.5:443', 'retryable'],
  ['connect ECONNREFUSED 203.0.113.5:443', 'retryable'],
  ['Headers Timeout Error', 'retryable'],
  ['other side closed', 'retryable'],
  ['Something odd happened', 'unknown'],
  ['', 'unknown'],
  [null, 'unknown'],
]
for (const [msg, want] of cases) assert.equal(cls(msg), want, `${JSON.stringify(msg)} → ${want}`)

const summary = summarizeHttpErrorClasses(['HTTP 404 from upstream', 'HTTP 404 from upstream', 'HTTP 500 from upstream'])
assert.deepEqual(summary.map(s => [s.error_class, s.count]), [['not_found', 2], ['retryable', 1]])
assert.ok(summary[1].hint.includes('"missing"'), 'HTTP retry hint names the HTTP rerun mode')

console.log('All http-error-classify assertions passed.')
