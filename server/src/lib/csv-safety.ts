// CSV defense — two distinct concerns, two distinct functions.
//
// (1) On INPUT (cell edits + CSV import): strip control characters that
//     SQLite, JSON encoders, downstream tools, or terminals would treat
//     specially. NUL / backspace / form-feed / etc. have no business in a
//     spreadsheet cell. Newline (0x0A) and tab (0x09) are preserved — those
//     are legitimate text content.
//
// (2) On EXPORT to CSV: prefix any cell whose first character is a formula
//     trigger (=, +, -, @, \t, \r) with a single quote, then standard
//     CSV-escape it (wrap in quotes, double up internal quotes). Excel /
//     Sheets / Numbers parse a leading quote as "this cell is text, do not
//     evaluate it" and the quote itself is hidden.
//
// We deliberately do NOT prefix on input. Mutating user data on the way in
// silently corrupts legitimate values (a user typing "=A1+B1" expects to
// see "=A1+B1" back). The injection threat lives at the spreadsheet-app
// boundary, so the defense lives there too.

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

// On CSV IMPORT: undo the guard above. A leading quote before a formula trigger
// is what our export (and a spreadsheet's "text" marker) adds, so dropping it
// gives back the value that was exported; the next export guards it again.
export function stripFormulaGuard(value: unknown): unknown {
  return typeof value === 'string' && value.length > 1 && value[0] === "'" && FORMULA_TRIGGERS.has(value[1])
    ? value.slice(1) : value;
}

// Unicode BIDI control characters. These have no legitimate use in a spreadsheet
// cell, but embedded in a value they reorder how the text renders — the classic
// abuse is U+202E (RIGHT-TO-LEFT OVERRIDE) turning "…gpj.exe" into a display of
// "…exe.jpg" to spoof a filename or a link. Strip them on input alongside the C0/
// C1 controls. Covered: LRM/RLM/ALM (200E/200F/061C), the embedding+override set
// (202A-202E), and the isolate set (2066-2069). Flagged in a security review.
export function isBidiControl(code: number): boolean {
  return code === 0x200E || code === 0x200F || code === 0x061C
    || (code >= 0x202A && code <= 0x202E)
    || (code >= 0x2066 && code <= 0x2069);
}

// Strip ASCII control characters except newline (0x0A) and tab (0x09).
// Range covers 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, plus the C1 range 0x7F–0x9F.
// Use a simple loop rather than a regex with surrogate-aware Unicode flags —
// these are all single-byte points so an ASCII-style char scan is fine and
// orders of magnitude faster than the regex engine on a 10k-row import.
export function stripControlChars(s: string): string {
  if (!s) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x0A || code === 0x09) {
      out += s[i];
      continue;
    }
    if (code < 0x20) continue;
    if (code >= 0x7F && code <= 0x9F) continue;
    if (isBidiControl(code)) continue;
    out += s[i];
  }
  return out;
}

// Truncate a cell value so the RESULT is at most `max` UTF-16 code units,
// WITHOUT splitting a surrogate pair at the cut (a lone surrogate would corrupt
// the JSON stored in rows.data). Appends a short, non-error-looking marker so a
// truncated cell reads as intentionally shortened — and the marker is counted
// INSIDE the budget, so `clampCellChars(s, max).length <= max` always holds (the
// advertised cap is the real stored ceiling). Returns the input unchanged when
// it's within the cap (the common case — no allocation).
const TRUNCATION_MARKER = '…[truncated]';
export function clampCellChars(s: string, max: number): string {
  if (s.length <= max) return s;
  // Reserve room for the marker so the total stays within `max`. If `max` is
  // somehow smaller than the marker, fall back to a hard slice (no marker).
  let cut = Math.max(0, max - TRUNCATION_MARKER.length);
  // If the char just before the cut is a HIGH surrogate (0xD800–0xDBFF), it's the
  // first half of a pair — drop it too so we never emit a lone surrogate.
  if (cut > 0) {
    const boundary = s.charCodeAt(cut - 1);
    if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
  }
  if (cut <= 0) return s.slice(0, max); // marker wouldn't fit — hard cap, no marker
  return s.slice(0, cut) + TRUNCATION_MARKER;
}

// CSV-escape one cell for export. Adds the leading-quote defense for
// formula triggers and applies the standard RFC-4180 quoting (wrap in "..."
// and double up internal "). Always quotes the field — slightly larger
// output but eliminates ambiguity around commas, newlines, and quotes.
export function escapeCsvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  // Prefix with single quote if first char is a formula trigger. The CSV
  // representation will be `"'=A1"` etc.; spreadsheet apps render that as
  // the literal text "=A1" (the quote is hidden).
  // A plain number ("-5", "+44", "-3.14") can't be a formula, so it's left as
  // is: prefixing it turned numbers into text after an export/re-import.
  const safe = str.length > 0 && FORMULA_TRIGGERS.has(str[0]) && !PLAIN_NUMBER.test(str) ? `'${str}` : str;
  // RFC-4180 quote-wrap with embedded-quote doubling.
  return `"${safe.replace(/"/g, '""')}"`;
}

// Build a safe Content-Disposition header value for a download named after
// user-controlled text (e.g. a sheet name).
//
// The threat: a raw name interpolated into `filename="..."` lets CR/LF inject
// extra headers (or split the response) and lets `"` break out of the quoted
// value. Stripping only `"` (as an earlier version did) leaves newlines and
// other control chars in place.
//
// We emit BOTH forms per RFC 6266:
//   - `filename="..."`  — an ASCII-only, control-char-free fallback for old
//     clients. Anything outside printable ASCII (or a `"` / `\`) is replaced
//     with `_` so the quoted-string cannot be escaped or truncated.
//   - `filename*=UTF-8''...` — RFC 5987 percent-encoded, so the full original
//     (incl. Unicode) survives in modern browsers, which prefer `filename*`.
// `base` is the name without extension; `ext` (e.g. "csv") is appended to both.
export function contentDispositionFilename(base: string, ext: string): string {
  const raw = `${base}.${ext}`;
  // ASCII fallback: drop control chars (incl. CR/LF/TAB) and anything non-ASCII,
  // and neutralize the quoted-string delimiters " and \.
  let ascii = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code > 0x7e || code === 0x22 || code === 0x5c) {
      ascii += '_';
    } else {
      ascii += raw[i];
    }
  }
  if (!ascii.trim()) ascii = `export.${ext}`;
  // RFC 5987 encoding: encodeURIComponent covers the dangerous bytes; we also
  // escape the few chars it leaves that aren't valid in an ext-value token.
  const encoded = encodeURIComponent(raw).replace(/['()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
