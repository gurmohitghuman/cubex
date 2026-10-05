// JSON-only response validation for the HTTP API enrichment feature.
//
// The feature extracts fields via JSONPath, so it only supports JSON responses.
// This module is ALSO the lever that stops the feature being used to scrape HTML
// pages through Cubex's shared egress IP: an ordinary web page comes back as
// text/html and is rejected here. Kept separate from the request-making machinery
// in http-request.ts (one responsibility per file).
//
// Policy (per security review):
//   - Reject explicit page/document media types (text/html, xml) OUTRIGHT, even
//     if the body would parse as JSON — those are pages, not data APIs.
//   - Otherwise require the body to PARSE as JSON. We do NOT trust the
//     Content-Type header alone: an upstream claiming application/json with a
//     malformed/HTML body is rejected. Conversely a real API that mislabels JSON
//     as text/plain (or omits the header) still works as long as it parses.
//   - Require a top-level object or array. A bare JSON scalar (string/number/
//     bool/null) is not something JSONPath extraction is meaningful on and is the
//     shape a disguised page-relay would most easily emit.

// Surfaced typed so the runner records a clean, user-facing per-row message
// instead of a generic failure.
export class NonJsonResponseError extends Error {
  constructor(reason: string) { super(reason); this.name = 'NonJsonResponseError'; }
}

// Media types we reject outright as "this is a page/document, not a data API",
// even if the body somehow parses as JSON. Matched on the bare media type (the
// part before any ';' parameters), case-insensitively.
const REJECTED_MEDIA_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml',
]);

// Lowercased bare media type (no charset/params), or '' if no Content-Type.
export const parseMediaType = (contentType: string | undefined): string =>
  (contentType || '').split(';')[0].trim().toLowerCase();

// True if ANY part of a (possibly comma-joined, duplicated) Content-Type is an
// explicitly-rejected page/document type. undici may surface a duplicated header
// as "text/html, application/json"; splitting only on ';' would miss the text/html
// part. Check every comma-separated media type so a disguised/duplicated header
// can't slip a page type past the explicit reject. (The downstream parse-required
// + object/array check already blocks the actual HTML body, but the stated policy
// is to reject the media type outright, with a clear message.)
const hasRejectedMediaType = (contentType: string | undefined): string | null => {
  for (const part of (contentType || '').split(',')) {
    const mt = parseMediaType(part);
    if (REJECTED_MEDIA_TYPES.has(mt)) return mt;
  }
  return null;
};

// A media type that ADVERTISES JSON: application/json, text/json, or any
// structured-suffix +json (application/vnd.api+json, application/hal+json,
// application/problem+json, …). Not TRUSTED to mean the body is valid JSON (we
// still parse), but used for clearer error messaging and to accept the long tail
// of JSON API content types.
const isJsonMediaType = (mediaType: string): boolean =>
  mediaType === 'application/json' || mediaType === 'text/json' || mediaType.endsWith('+json');

// Validate + parse an HTTP API response body. Returns the parsed JSON (object or
// array) or throws NonJsonResponseError with a user-facing reason.
export function parseJsonResponse(bodyText: string, contentType: string | undefined): any {
  const mediaType = parseMediaType(contentType);

  const rejected = hasRejectedMediaType(contentType);
  if (rejected) {
    throw new NonJsonResponseError(
      `HTTP API enrichment only supports JSON API responses. The upstream returned ` +
      `${rejected}; HTML/XML pages are not supported.`,
    );
  }

  // An empty 2xx body (204 No Content, or an API that returns "" for "no data")
  // is NOT an error and isn't an HTML page — map it to {} so JSONPath extraction
  // simply finds nothing (empty cell), matching prior behavior. Done AFTER the
  // page-type reject so an empty body with a text/html header still 400s.
  if (bodyText.trim() === '') return {};

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    const claim = isJsonMediaType(mediaType)
      ? `The upstream returned ${mediaType}, but the body was not valid JSON.`
      : `The upstream returned ${mediaType || 'no Content-Type'} and the body was not valid JSON.`;
    throw new NonJsonResponseError(`HTTP API enrichment only supports valid JSON responses. ${claim}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new NonJsonResponseError(
      `HTTP API enrichment expects a JSON object or array, but the upstream returned a ` +
      `single JSON ${parsed === null ? 'null' : typeof parsed} value.`,
    );
  }

  return parsed;
}
