// Reads a sheet's rows in pages between requests and finds its duplicates
// (lib/dedupe/): shared by the check and the removal. Key work yields every
// few dozen milliseconds and pages are sized by how long their read took
// (constants-dedupe.ts), so a million rows never hold the server, whatever a
// row costs to read or match.
import { db } from '../lib/db';
import { getSheetColumns, jsonPath } from '../lib/sql-helpers';
import {
  DEDUPE_FIRST_PAGE_ROWS, DEDUPE_MAX_PAGE_ROWS, DEDUPE_MIN_PAGE_ROWS, DEDUPE_READ_MS, DEDUPE_SLICE_MS,
} from '../lib/constants-dedupe';
import { yieldToRequests } from '../lib/slices';
import { BLANK_CHARS, FAILED_MARK, LIST_MARK, RUNNING_MARK, SKIPPED_MARK } from '../lib/run-markers';
import { DuplicateFinder, type FinderResult } from '../lib/dedupe/finder';
import { keyPart, rowKey } from '../lib/dedupe/key';
import type { DedupeRequest } from './dedupe-input';

// How many of the sheet's columns a row fills ("most complete"), worked out
// in SQLite so no row's whole data comes to JavaScript: a cell counts when it
// holds more than spaces and isn't a run's status (lib/run-markers.ts).
const FILLED_SQL = `(SELECT COUNT(*) FROM (
    SELECT TRIM(CAST(c.value AS TEXT), ?) AS t FROM json_each(rows.data) AS c
    WHERE c.key IN (SELECT value FROM json_each(?)))
  WHERE t != '' AND t NOT LIKE ? AND t NOT LIKE ? AND t NOT LIKE ? AND t NOT LIKE ?)`;
const MARK_PATTERNS = [RUNNING_MARK, FAILED_MARK, SKIPPED_MARK, LIST_MARK].map(m => `${m}%`);

// below: only rows under this position (a removal leaves rows appended
// meanwhile alone). Returns null when `signal` stopped it.
export interface ScanOptions { below?: number; signal?: AbortSignal }

export async function scanDuplicates(
  sheetId: string, userId: string, req: DedupeRequest, opts: ScanOptions = {},
): Promise<FinderResult | null> {
  const n = req.keys.length;
  const filled = req.keep === 'most_complete';
  const read = db.prepare(`SELECT rowid, row_index, ${req.keys.map(() => 'json_extract(data, ?)').join(', ')}
      ${filled ? `, ${FILLED_SQL}` : ''}
    FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ? AND row_index < ?
    ORDER BY row_index LIMIT ?`).raw();
  const head: unknown[] = req.keys.map(k => jsonPath(k.column));
  if (filled) head.push(BLANK_CHARS, JSON.stringify(getSheetColumns(sheetId, userId, false)), ...MARK_PATTERNS);
  const below = opts.below ?? Number.MAX_SAFE_INTEGER;
  const finder = new DuplicateFinder(req.keep);
  const parts: string[] = new Array(n);
  let page = DEDUPE_FIRST_PAGE_ROWS, position = 0, slice = performance.now();
  // Lets other requests in once this slice's work is long enough; false when `signal` stopped the scan.
  const breathe = async (): Promise<boolean> => {
    await yieldToRequests();
    slice = performance.now();
    return !opts.signal?.aborted;
  };
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    if (opts.signal?.aborted) return null;
    const reading = performance.now();
    const rows = read.all(...head, sheetId, userId, after, below, page) as unknown[][];
    const readMs = performance.now() - reading;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      for (let j = 0; j < n; j++) parts[j] = keyPart(req.keys[j], r[2 + j]);
      finder.add(r[0] as number, ++position, rowKey(parts), filled ? r[2 + n] as number : 0);
      if ((i & 127) === 127 && performance.now() - slice > DEDUPE_SLICE_MS && !(await breathe())) return null;
    }
    if (rows.length < page) break;
    after = rows[rows.length - 1][1] as number;
    if (readMs > DEDUPE_READ_MS) page = Math.max(DEDUPE_MIN_PAGE_ROWS, page >> 1);
    else if (readMs < DEDUPE_READ_MS / 4) page = Math.min(DEDUPE_MAX_PAGE_ROWS, page * 2);
    if (!(await breathe())) return null;
  }
  return finder.result();
}
