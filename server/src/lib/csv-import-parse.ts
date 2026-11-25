import fs from 'fs';
import { Readable } from 'stream';
import csv from 'csv-parser';
import { sanitizeColumnName } from './sql-helpers';
import { stripControlAndC1Chars, stripFormulaGuard } from './csv-safety';
import { stripInvisibleNameChars } from './name-safety';
import { cutChars } from './row-select/cut-cells';

// Parsing half of CSV import (the validation + cap checks live in
// csv-import-validate.ts). ZERO mutation — nothing here touches the sheet.
//
// An uploaded file is never held in memory: one streaming pass checks the
// headers and counts the rows (enough to validate), and the commit streams the
// file again to insert. A million-row CSV costs a few MB of memory, not GB.

// What validation needs: the columns (sanitized header list in CSV order, then
// any extra keys a long row carries) and the row count.
export interface CsvSummary { headers: string[]; columns: string[]; rowCount: number }
export interface ScannedCsv { summary: CsvSummary; rows: () => AsyncIterable<Record<string, unknown>> }

// A header as a refusal quotes it: the message goes into the API answer and the server log (which `cubex logs`
// prints), so no control character (ESC, C1, a line break, a direction control) gets there, and a long one is cut.
const SHOWN_HEADER_CHARS = 80;
function shownHeader(raw: string): string {
  const clean = stripInvisibleNameChars(stripControlAndC1Chars(String(raw))).replace(/\s+/g, ' ').trim();
  // cutChars never ends on the first half of a surrogate pair (an emoji cut in two).
  return clean.length > SHOWN_HEADER_CHARS ? `${cutChars(clean, SHOWN_HEADER_CHARS)}…` : clean;
}

// Thrown when two raw CSV headers collapse to the same sanitized name. The route
// catches this and returns it as a clean 400 (not a 500). Distinct class so we
// don't swallow it with generic "couldn't parse" errors.
export class CsvHeaderCollisionError extends Error {}

// Strip a leading UTF-8 BOM (Excel/Windows prepend U+FEFF to the first header,
// which would otherwise survive into the column name and fail the name rule).
const stripBom = (s: string): string => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;

// Sanitizes keys at the import boundary. CSV headers in the wild include quotes,
// whitespace, a BOM and characters that break SQLite's JSON path syntax.
class KeySanitizer {
  private cache = new Map<string, string>();
  readonly headers: string[] = [];

  // Byte-identical duplicates ("Name,Name") are only visible here: csv-parser
  // collapses them into one row key, silently dropping a column's data.
  constructor(rawHeaders: string[]) {
    const seenRaw = new Set<string>();
    const sanitizedToRaw = new Map<string, string>();
    for (const raw of rawHeaders) {
      if (seenRaw.has(raw)) {
        throw new CsvHeaderCollisionError(
          `The CSV has two columns named "${shownHeader(raw)}". Rename one in the CSV and re-upload.`);
      }
      seenRaw.add(raw);
      const k = this.key(raw);
      const prevRaw = sanitizedToRaw.get(k);
      if (prevRaw !== undefined) throw collision(prevRaw, raw, k);
      sanitizedToRaw.set(k, raw);
      this.headers.push(k);
    }
  }

  key(raw: string): string {
    let k = this.cache.get(raw);
    if (k === undefined) { k = sanitizeColumnName(stripFormulaGuard(stripBom(raw)) as string); this.cache.set(raw, k); }
    return k;
  }

  // Two distinct raw keys can sanitize to the SAME name (`Name` + `Name\`); a
  // blind rebuild would overwrite one column's cell with the other's. Reject.
  // A null-prototype row, so a column named "__proto__" is an own key like any other (as parseCellMap's rows are).
  row(raw: Record<string, unknown>, names: Map<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null);
    const sanitizedToRaw = new Map<string, string>();
    for (const [stood, v] of Object.entries(raw)) {
      const rawKey = names.get(stood) ?? stood;
      const k = this.key(rawKey);
      const prevRaw = sanitizedToRaw.get(k);
      if (prevRaw !== undefined && prevRaw !== rawKey) throw collision(prevRaw, rawKey, k);
      sanitizedToRaw.set(k, rawKey);
      out[k] = stripFormulaGuard(v);
    }
    return out;
  }
}

const collision = (a: string, b: string, k: string) => new CsvHeaderCollisionError(
  `CSV columns "${shownHeader(a)}" and "${shownHeader(b)}" resolve to the same name "${shownHeader(k)}". Rename `
  + 'one in the CSV and re-upload.',
);

// Excel in many locales saves "CSV" with semicolons (the comma being the decimal
// separator), and some tools use tabs. Pick the separator from the header line:
// the most common of , ; and tab outside quotes, comma on a tie.
export function sniffSeparator(sample: string): string {
  const line = stripBom(sample).split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const sep of [';', '\t']) if (counts[sep] > counts[best]) best = sep;
  return best;
}

// The first 64 KB of a file, enough to hold its header line.
function fileHead(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally { fs.closeSync(fd); }
}

// csv-parser drops the columns it can't use as plain object keys (it gives null for "__proto__", "constructor" and
// "prototype", so the file failed to import). They go through it under a name of their own (a NUL and the column's
// place: a NUL can't survive in a column name, sanitizeColumnName strips it) and are named back here.
const OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Sanitized rows, one at a time. The sanitizer comes from the header line.
async function* sanitizedRows(
  source: Readable, separator: string, onHeaders: (s: KeySanitizer) => void,
): AsyncGenerator<Record<string, unknown>> {
  let sanitizer: KeySanitizer | null = null;
  const names = new Map<string, string>();
  const mapHeaders = ({ header, index }: { header: string; index: number }) => {
    if (!OBJECT_KEYS.has(header)) return header;
    const stood = `\u0000${index}`;
    names.set(stood, header);
    return stood;
  };
  const parser = source.pipe(csv({ separator, mapHeaders }));
  parser.on('headers', (h: string[]) => {
    try {
      sanitizer = new KeySanitizer(h.map(x => names.get(x) ?? x));
      onHeaders(sanitizer);
    } catch (err) { parser.destroy(err as Error); }
  });
  for await (const raw of parser) yield sanitizer!.row(raw as Record<string, unknown>, names);
  if (!sanitizer) onHeaders(new KeySanitizer([])); // an empty file has no header line
}

async function summarize(source: Readable, separator: string): Promise<CsvSummary> {
  let sanitizer: KeySanitizer | null = null;
  const extra: string[] = [];
  const known = new Set<string>();
  let rowCount = 0;
  for await (const row of sanitizedRows(source, separator, s => { sanitizer = s; s.headers.forEach(h => known.add(h)); })) {
    rowCount++;
    for (const k of Object.keys(row)) if (!known.has(k)) { known.add(k); extra.push(k); }
  }
  const headers = (sanitizer as KeySanitizer | null)?.headers ?? [];
  return { headers, columns: [...headers, ...extra], rowCount };
}

export async function scanCsvFile(filePath: string): Promise<ScannedCsv> {
  const separator = sniffSeparator(fileHead(filePath));
  const summary = await summarize(fs.createReadStream(filePath), separator);
  return { summary, rows: () => sanitizedRows(fs.createReadStream(filePath), separator, () => {}) };
}

// CSV handed over as a STRING (the MCP import_csv tool: tool args are JSON and
// the /mcp body cap bounds the size), so its rows are simply kept. The same
// sanitize/collision rules as an upload.
export async function scanCsvText(text: string): Promise<ScannedCsv> {
  const rows: Record<string, unknown>[] = [];
  let headers: string[] = [];
  for await (const row of sanitizedRows(Readable.from([text]), sniffSeparator(text), s => { headers = s.headers; })) rows.push(row);
  const known = new Set(headers);
  const extra = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => !known.has(k));
  return {
    summary: { headers, columns: [...headers, ...extra], rowCount: rows.length },
    rows: async function* () { yield* rows; },
  };
}
