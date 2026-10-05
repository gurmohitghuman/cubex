// Typed errors thrown along the user-supplied outbound-HTTP path. Kept in their
// own dependency-free module so both the request machinery (http-request.ts) and
// the runner can import them without pulling in the undici/request code.
//
// Each is surfaced typed so the runner can record a clean, user-facing per-row
// error message instead of a generic "fetch failed".

// URL rejected by the SSRF guard ("URL not allowed: …").
export class OutboundBlockedError extends Error {
  constructor(reason: string) { super(reason); this.name = 'OutboundBlockedError'; }
}
