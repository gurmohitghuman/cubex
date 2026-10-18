// Typed errors thrown along the user-supplied outbound-HTTP path. Kept in their
// own dependency-free module so both the request machinery (http-request.ts) and
// the runner can import them without pulling in the undici/request code.
//
// Each is surfaced typed so the runner can record a clean, user-facing per-row
// error message instead of a generic "fetch failed", and decide whether trying
// again can help (lib/http-retry.ts).

// URL rejected by the SSRF guard ("URL not allowed: …").
export class OutboundBlockedError extends Error {
  constructor(reason: string) { super(reason); this.name = 'OutboundBlockedError'; }
}

// The API answered with a status outside 2xx. The message keeps its old
// "HTTP <code> from upstream: …" form (lib/http-error-classify.ts reads it).
export class UpstreamStatusError extends Error {
  readonly responseStatus: number;
  constructor(readonly status: number, readonly retryAfter: string | null, message: string) {
    super(message);
    this.name = 'UpstreamStatusError';
    this.responseStatus = status;
  }
}

// No answer: the connection was refused or reset, or the API took too long.
export class NetworkError extends Error {
  constructor(message: string) { super(message); this.name = 'NetworkError'; }
}

// Failures of the connection itself: refused, reset, closed early, timed out,
// a name that didn't resolve for now. Anything else undici throws (a header
// value with a line break, a bad argument) happens before a byte is sent and
// can't be fixed by trying again.
const TRANSPORT_CODES = new Set([
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENETDOWN', 'EHOSTDOWN',
]);
export function isTransportFailure(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return TRANSPORT_CODES.has(String(e?.code)) || TRANSPORT_CODES.has(String(e?.cause?.code));
}

// An error thrown after the API answered (a 2xx body that isn't JSON or is too
// large) carries the status too, for the response code column.
export function withResponseStatus<E>(error: E, status: number): E {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, 'responseStatus', { value: status, enumerable: false, configurable: true });
  }
  return error;
}

export function responseStatusOf(error: unknown): number | null {
  const s = (error as { responseStatus?: unknown } | null)?.responseStatus;
  return typeof s === 'number' && Number.isInteger(s) ? s : null;
}
