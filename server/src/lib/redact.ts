// Secret redaction for logs and persisted error messages. Extracted from
// http-request.ts so it has one clear home — both the SSRF/HTTP path and the
// AI/HTTP run workers depend on it, and it must stay independent of any
// request-making code. http-request.ts re-exports these for back-compat.
//
// Defensive: OpenRouter/OpenAI/Anthropic errors sometimes echo the offending
// key prefix in 401/403 response messages; user HTTP templates carry their own
// auth. We strip key/credential-shaped tokens before logging or persisting.
//
// Patterns covered:
//   sk-or-v1-*  OpenRouter
//   sk-ant-*    Anthropic
//   sk-*        OpenAI / generic
//   Bearer <token>  any auth header echo
//   Basic <token>   basic-auth header echo
//   Authorization: <scheme> <token>  any other auth scheme
//   X-API-Key / api-key / api_key: <value>  common API-key header echoes
//   ?api_key= / &token= / &key=  credentials in a URL query string
//   scheme://user:pass@host  credentials in a URL userinfo segment
//   cubex_pat_*  Cubex personal access tokens (bare echoes outside a header)
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:or-v\d+|ant|[A-Za-z0-9])[A-Za-z0-9_\-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-=]{8,}/gi,
  // Authorization header echo. Group 1 keeps `Authorization:` plus an OPTIONAL
  // scheme word (Token/ApiKey/Digest/…), group-less tail is the credential we
  // redact. Must consume the WHOLE value (scheme + token), not just one word —
  // `Authorization: Token abc` would otherwise leave `abc` exposed. Each piece
  // is a bounded \S+ with single spaces between, so no catastrophic backtracking.
  /\b(Authorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9._-]*\s+)?)\S+/gi,
  /\b(?:x-api-key|api[-_]?key|api[-_]?secret|access[-_]?token)\s*[:=]\s*\S+/gi,
  /([?&](?:api[-_]?key|api[-_]?secret|access[-_]?token|token|key|password)=)[^&\s]+/gi,
  /([a-z][a-z0-9+.\-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi,
  // Incoming-webhook capability token in the URL PATH (/api/webhooks/<token>).
  // The token is a write capability, so if anything ever logs a request URL or an
  // error embeds the full webhook URL, strip the token while keeping the path
  // readable. Matches the base64url token segment after the /api/webhooks/ prefix.
  /(\/api\/webhooks\/)[A-Za-z0-9_-]{20,}/g,
  // Personal access token (cubex_pat_<64 hex>). The Bearer pattern above catches
  // header echoes, but a bare token in an error message (client library dumps,
  // curl output in a bug report) needs its own pattern.
  /\bcubex_pat_[0-9a-f]{10,}/g,
];

// Replacement keeps any leading group (the header/param name / url prefix) so
// the redacted string stays readable: `?api_key=[REDACTED]`, `user:[REDACTED]@host`.
export function redactSecrets(input: string): string {
  let out = input;
  out = out.replace(SECRET_PATTERNS[0], '[REDACTED]');
  out = out.replace(SECRET_PATTERNS[1], '[REDACTED]');
  out = out.replace(SECRET_PATTERNS[2], '$1[REDACTED]');
  out = out.replace(SECRET_PATTERNS[3], (m) => m.slice(0, m.search(/[:=]/) + 1) + ' [REDACTED]');
  out = out.replace(SECRET_PATTERNS[4], '$1[REDACTED]');
  out = out.replace(SECRET_PATTERNS[5], '$1:[REDACTED]@');
  out = out.replace(SECRET_PATTERNS[6], '$1[REDACTED]');
  out = out.replace(SECRET_PATTERNS[7], '[REDACTED]');
  return out;
}

// Format a caught error for LOGGING: redacted + bounded. Use this instead of
// passing a raw error to console.error in the run workers — a provider/library
// error can echo an API key or an Authorization header into its message/stack,
// which would otherwise land in plaintext logs. Includes the stack (also
// redacted) since that's the useful part for debugging.
export function redactError(error: unknown): string {
  const raw = error instanceof Error ? (error.stack || error.message) : String(error);
  return redactSecrets(raw).slice(0, 1000);
}
