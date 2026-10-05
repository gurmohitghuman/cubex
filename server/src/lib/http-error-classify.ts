// Classify a persisted HTTP row error into what to DO about it, as
// ai-error-classify.ts does for AI rows (AI classes don't fit: an upstream 404
// is neither a prompt nor a model problem, and came back "unknown"). Read-time
// and pure: regexes over the messages http-row.ts records, which come from
// http-request.ts ("HTTP 404 from upstream: …"), outbound-guard.ts,
// http-response-json.ts and http-request-template.ts.

export type HttpErrorClass =
  // Rate limits, timeouts, 5xx, dropped connections: a rerun will likely work.
  | 'retryable'
  // 404/410: the API has nothing for this row's value. Data, not a fault,
  // unless every row says it (then the URL path is wrong).
  | 'not_found'
  // The request is wrong: auth (401/403), other 3xx/4xx, a {{name}}, a header,
  // a JSONPath, or an address the guard blocks. A rerun repeats it.
  | 'configuration'
  // The API answered, but not with JSON Cubex can read, or too much of it.
  | 'response_format'
  | 'unknown';

const RULES: ReadonlyArray<{ cls: HttpErrorClass; re: RegExp }> = [
  { cls: 'not_found', re: /^HTTP (404|410) from upstream/ },
  // 501/505: the server doesn't do this method or HTTP version, so retrying won't help.
  { cls: 'configuration', re: /^HTTP (501|505) from upstream/ },
  { cls: 'retryable', re: /^HTTP (408|425|429|5\d\d) from upstream/ },
  { cls: 'configuration', re: /^HTTP [34]\d\d from upstream/ },
  { cls: 'configuration', re: /doesn't match a column or a saved key|not a valid header name|^JSONPath "/ },
  { cls: 'configuration', re: /private\/internal address|Only http\(s\) URLs|^Invalid URL|missing a hostname|^Could not resolve|^URL not allowed/ },
  { cls: 'response_format', re: /only supports (?:valid )?JSON|expects a JSON object or array|exceeds the \d+MB cap/ },
  // Transport failures: errno codes in Node's messages ("connect ECONNREFUSED …")
  // and undici's ("Headers Timeout Error", "other side closed").
  { cls: 'retryable', re: /\b(ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ECONNABORTED|EHOSTUNREACH|ENETUNREACH)\b/ },
  { cls: 'retryable', re: /timeout|timed out|socket hang ?up|other side closed|fetch failed/i },
];

export function classifyHttpError(errorMessage: string | null | undefined): HttpErrorClass {
  const msg = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  if (!msg) return 'unknown';
  return RULES.find(rule => rule.re.test(msg))?.cls ?? 'unknown';
}

export const HTTP_ERROR_CLASS_HINT: Record<HttpErrorClass, string> = {
  retryable:
    'Transient (rate limit, timeout or server error). Re-running these rows will likely work (control_run action "rerun" mode "missing").',
  not_found:
    'The API had nothing for this row\'s value (404/410). If every row says this, the URL path is wrong; otherwise that is the answer, and a rerun won\'t change it.',
  configuration:
    'The request is wrong: the URL, method, headers, API key (401/403), a {{name}}, a JSONPath, or a blocked address. Fix the config; a rerun repeats the error.',
  response_format:
    'The API answered, but not with a JSON object or array Cubex can read (or the response was too large). Point the URL at a JSON endpoint.',
  unknown:
    'Unrecognized error. Read error_message directly before re-running; do not assume it is transient.',
};

// Per-class counts for a page of failures, most common first.
export function summarizeHttpErrorClasses(
  errors: ReadonlyArray<string | null | undefined>,
): Array<{ error_class: HttpErrorClass; count: number; hint: string }> {
  const counts = new Map<HttpErrorClass, number>();
  for (const e of errors) {
    const cls = classifyHttpError(e);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([error_class, count]) => ({ error_class, count, hint: HTTP_ERROR_CLASS_HINT[error_class] }));
}
