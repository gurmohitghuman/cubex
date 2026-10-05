import { JSONPath } from 'jsonpath-plus';
import { WEBHOOK_MAX_JSONPATH_LEN } from './constants';

// Allowlist matching EXACTLY the grammar the client path-builder
// (json-mapping/jsonPath.ts) emits: a leading `$`, then zero or more segments,
// each being `.identifier`, `["double-quoted key"]`, or `[integer]`. This
// REJECTS jsonpath-plus's powerful constructs — filter `[?(...)]` and script
// `[(...)]` expressions, recursive `..`, wildcards `*`, `@` — none of which the
// UI can produce. Mapping paths are stored once (authenticated) but then run on
// EVERY unauthenticated webhook POST, so an attacker-crafted script/filter path
// would be repeatedly server-evaluated; the allowlist closes that off at the
// source. (Extraction ALSO runs with eval:false as defense in depth.)
const SAFE_SEGMENT = /\.[A-Za-z_$][A-Za-z0-9_$]*|\["(?:[^"\\]|\\.)*"\]|\[\d+\]/;
const SAFE_JSONPATH = new RegExp(`^\\$(?:${SAFE_SEGMENT.source})*$`);

export interface PathValidation { ok: boolean; reason?: string }

// Validate a user-supplied mapping path against the client builder grammar +
// length cap. Call at mapping-CREATE time (sheets-webhooks.ts).
export function validateMappingPath(path: string): PathValidation {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: 'Path is required.' };
  if (path.length > WEBHOOK_MAX_JSONPATH_LEN) {
    return { ok: false, reason: `Path exceeds the ${WEBHOOK_MAX_JSONPATH_LEN}-character limit.` };
  }
  if (!SAFE_JSONPATH.test(path)) {
    return { ok: false, reason: 'Path must be a simple field path (no filters, scripts, wildcards, or recursion).' };
  }
  return { ok: true };
}

// LOOSER validation for the AUTHENTICATED HTTP-enrichment path (validateHttpRunColumns).
// Unlike the webhook path (unauthenticated → strict allowlist), the HTTP modal has
// always documented wildcard/recursive paths like `$.results[*].title`, and
// jsonpath-plus runs them safely with eval:false. So we DON'T reject `*`/`..`/
// indexes/slices here — we only require a non-empty, length-bounded path and reject
// the EVAL-required constructs (filter `[?(...)]`, script `[(...)]`) up front, which
// eval:false neutralizes anyway but which we surface as a clean config error rather
// than a silent per-row no-match. Genuinely malformed paths are caught at extraction
// (extractOutcome) and surfaced as a row error.
// Positive allowlist for the HTTP-enrichment segment grammar. It is a SUPERSET of
// the strict webhook grammar (SAFE_SEGMENT): the HTTP modal has always documented
// and allowed wildcards `*`, recursive descent `..`, and array indexes (examples in
// the modal: `$.data[0].value`, `$.results[*].title`).
// A segment is one of:
//   .identifier   ..identifier   .*   ..*      (dot / recursive dot / wildcard)
//   ["quoted key"]                              (bracket-quoted, backslash-escapes ok)
//   [integer]   [*]                             (array index / wildcard index)
// This does NOT (and must not) match a malformed shell like `$.nope[`, `$.a[b`,
// `$[`, or a path with no leading `$` — the whole POINT of this fix. Those used to
// slip through (jsonpath-plus is not a syntax validator: it silently returns [] or,
// worse, a WRONG value for `$.a[b`), so a bad path produced blank/incorrect cells
// instead of a clean config error. Eval constructs (`[?(...)]` filter / `[(...)]`
// script) simply aren't in the grammar, so they're rejected too.
const HTTP_SAFE_SEGMENT =
  /\.\.?[A-Za-z_$][A-Za-z0-9_$]*|\.\.?\*|\["(?:[^"\\]|\\.)*"\]|\[\d+\]|\[\*\]/;
const HTTP_SAFE_JSONPATH = new RegExp(`^\\$(?:${HTTP_SAFE_SEGMENT.source})*$`);

// LOOSER than the strict webhook validateMappingPath (which rejects `*`/`..`), but
// still a POSITIVE grammar — genuinely malformed paths are rejected up front on
// /run and /preview (http-run-validate.ts) instead of silently no-matching per row.
export function validateHttpJsonPath(path: string): PathValidation {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: 'Path is required.' };
  if (path.length > WEBHOOK_MAX_JSONPATH_LEN) {
    return { ok: false, reason: `Path exceeds the ${WEBHOOK_MAX_JSONPATH_LEN}-character limit.` };
  }
  if (!HTTP_SAFE_JSONPATH.test(path)) {
    return {
      ok: false,
      reason: 'Path must be a valid JSONPath: a leading "$" then fields (.name), keys (["key"]), or array access ([0], [*], ..). No filters, scripts, slices, or unions.',
    };
  }
  return { ok: true };
}

// Neutral JSONPath extraction shared by the HTTP-enrichment runner and the
// webhook ingestion path. It lives here (NOT in http-request.ts) so a *receiver*
// like the webhook endpoint can extract response fields without pulling in
// outbound HTTP / undici / the SSRF guard / the request cache / redaction — none
// of which an inbound webhook should depend on. One dialect, one function, both
// features. http-request.ts re-exports this for back-compat with existing imports.

// Resolve a JSONPath against a payload, surfacing the distinction the caller needs:
//   - matched   : the first matched value (may itself be null/object/array)
//   - matched=false, no error : path simply didn't match (-> blank cell, normal)
//   - error set : the path was malformed / JSONPath threw (-> caller may flag partial)
export interface ExtractOutcome {
  matched: boolean;
  value: any;
  error?: string;
}

export function extractOutcome(payload: any, jsonPath: string): ExtractOutcome {
  try {
    // eval:false disables filter `[?(...)]` and script `[(...)]` expression
    // evaluation (which jsonpath-plus runs via the JS engine). Neither the HTTP
    // nor the webhook click-to-map builder produces those, so disabling them is a
    // no-op for legitimate paths and closes a server-side code-execution surface
    // — important because webhook mapping paths run on every UNAUTHENTICATED POST.
    const result = JSONPath({ path: jsonPath, json: payload, eval: false });
    if (Array.isArray(result) && result.length > 0) return { matched: true, value: result[0] };
    return { matched: false, value: null };
  } catch (error) {
    return { matched: false, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// Pull a JSONPath value out of a payload. Returns null if the path didn't match
// OR threw. Back-compat wrapper over extractOutcome for the HTTP runner, which
// only cares about the value. Webhook ingestion uses extractOutcome directly so a
// malformed mapping path can mark the delivery 'partial'.
//
// Path dialect is jsonpath-plus. Callers MUST build paths that bracket-quote keys
// containing dots/spaces/hyphens/quotes (e.g. $["event.type"], $.data["first name"]);
// a naive `${path}.${key}` for a key like "event.type" would wrongly read a nested
// `event.type` object. The client builder (json-mapping/jsonPath.ts) and the server
// emit the same bracket-or-dot notation so this resolver gets a well-formed path.
export function extractDataWithJSONPath(payload: any, jsonPath: string): any {
  const out = extractOutcome(payload, jsonPath);
  if (out.error) console.error(`JSONPath extraction error for path "${jsonPath}":`, out.error);
  return out.matched ? out.value : null;
}
