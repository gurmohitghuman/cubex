// CSV defense — two distinct concerns, two distinct functions.
//
// (1) On INPUT (every write of cell data: edits, imports, webhooks, runs):
//     strip the ASCII control characters that SQLite, JSON encoders,
//     downstream tools, or terminals would treat specially (NUL, backspace,
//     escape, DEL...) and the BIDI controls. Newline (0x0A) and tab (0x09) are
//     preserved: those are legitimate text content. U+0080-U+009F (C1) are
//     KEPT in cell data: they are what text decoded with the wrong character
//     set holds ("FraudFighterâ" + U+0084 + "¢" is the UTF-8 of "™" read as
//     Latin-1), and only with them in place can it be repaired (the
//     fix_encoding cleaner, lib/clean/fix-encoding.ts). Names, descriptions and
//     labels still drop them (stripControlAndC1Chars).
//
// (2) On EXPORT to CSV: prefix any cell whose first visible character is a
//     formula trigger (=, +, -, @, \t, \r, or a full-width or look-alike
//     form of one) with a single quote, then standard CSV-escape it (wrap in
//     quotes, double up internal quotes). "Visible": past leading C1 characters,
//     spaces and invisible characters, which spreadsheet apps skip before they
//     decide a cell is a formula. Excel / Sheets / Numbers parse a leading quote
//     as "this cell is text, do not evaluate it" and the quote itself is hidden.
//
// We deliberately do NOT prefix on input. Mutating user data on the way in
// silently corrupts legitimate values (a user typing "=A1+B1" expects to
// see "=A1+B1" back). The injection threat lives at the spreadsheet-app
// boundary, so the defense lives there too.

// The ASCII triggers, and the full-width and look-alike forms some apps and locales read as them (OWASP's
// CSV injection guide lists ＝ ＋ － ＠; LibreOffice was reported to take ﹦ and the minus sign −). Numbers
// evaluates ＝1+1 (checked 2026-11-24, tests/unit/csv-guard-visible.test.ts says which).
const FORMULA_TRIGGERS = new Set([
  '=', '+', '-', '@', '\t', '\r',
  '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20', // ＝ ＋ － ＠ (full-width)
  '\uFE66', '\uFE62', '\uFE63', '\u2212', // ﹦ ﹢ ﹣ (small forms) and − (minus sign)
]);
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const isC1 = (code: number): boolean => code >= 0x80 && code <= 0x9F;

// What an app skips before it decides a cell is a formula: C1 characters (an app may drop them as it opens
// the file), spaces of every width and line breaks, and the invisible characters. Numbers 2026 evaluates
// " =1+1", NBSP, zero-width space, ideographic space, a line feed and U+0085 before "=1+1" (checked 2026-11-24);
// Excel, LibreOffice and Google Sheets were reported to skip leading whitespace too. A BOM is skipped as well,
// though Numbers kept it as text: another app may drop it. Tab and CR are triggers of their own.
function skippedBeforeFormula(code: number): boolean {
  if (code < 0x80) return code === 0x20 || code === 0x0A;
  return isC1(code) || code === 0xA0 || code === 0x1680 || code === 0x180E
    || (code >= 0x2000 && code <= 0x200D) // en/em/thin... spaces, zero-width space, ZWNJ, ZWJ
    || code === 0x2028 || code === 0x2029 || code === 0x202F || code === 0x205F || code === 0x2060
    || code === 0x3000 || code === 0xFEFF;
}

// Where a value's formula check starts: past what an app skips there (above), so the guard looks where the
// app will. "\u00A0=HYPERLINK(...)" is a formula to Numbers.
function afterSkipped(value: string, from = 0): number {
  let i = from;
  while (i < value.length && skippedBeforeFormula(value.charCodeAt(i))) i++;
  return i;
}

// Whether the export guard quotes this value. A value the import would take a
// quote off ("'=x", a quote then skipped characters then a trigger) gets one
// more, so it comes back whole.
function needsFormulaGuard(str: string): boolean {
  if (stripFormulaGuard(str) !== str) return true;
  const at = afterSkipped(str);
  if (at >= str.length || !FORMULA_TRIGGERS.has(str[at])) return false;
  // A plain number ("-5", "+44", "-3.14") can't be a formula, so it's left as
  // is: prefixing it turned numbers into text after an export/re-import.
  return !PLAIN_NUMBER.test(at === 0 ? str : str.slice(at));
}

// On CSV IMPORT: undo the guard above. A leading quote before a formula trigger
// (or before skipped characters and then a trigger) is what our export (and a
// spreadsheet's "text" marker) adds, so dropping it gives back the value that
// was exported; the next export guards it again. More quotes before that are a
// guarded value that started with one ("''=x" was "'=x"): one quote comes off.
export function stripFormulaGuard(value: unknown): unknown {
  if (typeof value !== 'string' || value[0] !== "'") return value;
  let i = 1;
  while (value[i] === "'") i++;
  const at = afterSkipped(value, i);
  return at < value.length && FORMULA_TRIGGERS.has(value[at]) ? value.slice(1) : value;
}

// Unicode BIDI control characters. These have no legitimate use in a spreadsheet
// cell, but embedded in a value they reorder how the text renders — the classic
// abuse is U+202E (RIGHT-TO-LEFT OVERRIDE) turning "…gpj.exe" into a display of
// "…exe.jpg" to spoof a filename or a link. Strip them on input alongside the
// ASCII controls (cell data keeps C1, see above). Covered: LRM/RLM/ALM
// (200E/200F/061C), the embedding+override set (202A-202E), and the isolate set
// (2066-2069). Flagged in a security review.
export function isBidiControl(code: number): boolean {
  return code === 0x200E || code === 0x200F || code === 0x061C
    || (code >= 0x202A && code <= 0x202E)
    || (code >= 0x2066 && code <= 0x2069);
}

// One scan for both strippers. Use a simple loop rather than a regex with
// surrogate-aware Unicode flags: these are all single-unit code points, so a
// char scan is fine and orders of magnitude faster than the regex engine on a
// million-row import.
function stripControls(s: string, dropC1: boolean): string {
  if (!s) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x0A || code === 0x09) {
      out += s[i];
      continue;
    }
    if (code < 0x20 || code === 0x7F) continue;
    if (dropC1 && isC1(code)) continue;
    if (isBidiControl(code)) continue;
    out += s[i];
  }
  return out;
}

// Cell data, on every write path: drops 0x00-0x08, 0x0B-0x1F, DEL (0x7F) and
// the BIDI controls; keeps tab, newline and U+0080-U+009F (see the top).
export const stripControlChars = (s: string): string => stripControls(s, false);

// Names, descriptions, labels and log text: the same, and C1 goes too. Nothing
// there is repaired later, and a C1 character only makes such text differ
// from what people see.
export const stripControlAndC1Chars = (s: string): string => stripControls(s, true);

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
  // Prefix with single quote if the first visible char (past C1, spaces and
  // invisible characters) is a formula trigger. The CSV representation will be `"'=A1"` etc.; spreadsheet
  // apps render that as the literal text "=A1" (the quote is hidden).
  const safe = needsFormulaGuard(str) ? `'${str}` : str;
  // RFC-4180 quote-wrap with embedded-quote doubling.
  return `"${safe.replace(/"/g, '""')}"`;
}

// CSV-escape one cell exactly as it is, with no formula guard: for a file going into another tool (a CRM, a
// sending tool), which would keep the guard's quote as part of the value ('+1 415..., '@handle). Only RFC-4180
// quoting. Never for a file opened in a spreadsheet app: a cell starting with = + - @ may run there as a formula.
export function escapeCsvCellRaw(value: string | null | undefined): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
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
