// Which rows of a webhook sheet auto-delete may take next (services/webhook-auto-delete-sweep.ts), read a window
// at a time in row order through the sheet's (sheet_id, user_id, row_index) index, never the whole sheet. A row
// may leave when it is older than the newest keep_rows, the webhook added it (its column holds the 📥 mark: rows
// typed, imported or moved in stay), and it is finished: every auto-run column on the sheet has run on it, and
// with a success column, that column holds a result.
// - Run by an auto-run column: below its watermark (the rows it has looked at: lib/autorun-mark.ts), not queued
//   in autorun_pending (an input was written since), and its cell not ⏳ (a run is filling it). A row it looked at
//   and left (an empty input, "Only run if" not met) counts as run: it runs only once an input is written. A run
//   that failed (❌) counts as run too, unless the success column is that column.
// - Every enabled auto-run column holds the rows it hasn't run, paused or not: pausing promises that rows added
//   meanwhile run when it resumes. A column with auto-run off holds none.
// - A success column's result: not empty and not a run's mark (⏳, ❌, ⏭️, ➕). A row whose run there failed stays,
//   until it succeeds.
// In mode rules a row leaves once it passes the rules instead (auto-run's watermarks and queue aren't asked).
// In either mode a row still in progress stays: ⏳ (being filled) or ➕ (a list job's results still on their way)
// in any of the sheet's run columns, the rule language's own "running". The rules are worked out on each row of the window, as a
// column of the read, so a window still reads at most `scan` rows however few pass.
import { db } from '../lib/db';
import { jsonPath } from '../lib/json-path';
import { holdsRunMarker, LIST_MARK, RUNNING_MARK, trimBlank } from '../lib/run-markers';
import type { CompiledFilter } from '../lib/row-filter/sql';

export interface Holding { id: string; watermark: number; column: string }

export function autoRunsHolding(sheetId: string, userId: string): Holding[] {
  return db.prepare(`SELECT id, watermark_row_index AS watermark, status_column AS column FROM autorun_columns
    WHERE sheet_id = ? AND user_id = ? AND enabled = 1`).all(sheetId, userId) as Holding[];
}

// The newest row that may leave, the (keep + 1)th from the bottom, from the index alone (no row is read);
// undefined when the sheet has keep rows or fewer. Rows deleted leave gaps in row_index, so it is walked, not
// worked out: about 5 ms at 100,000 kept.
// (Exported with the window's query for tests/unit/webhook-auto-delete.test.ts, which checks their plans.)
export const NEWEST_LEAVING_SQL = `SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ?
  ORDER BY row_index DESC LIMIT 1 OFFSET ?`;
export const newestLeaving = (sheetId: string, userId: string, keep: number): number | undefined =>
  db.prepare(NEWEST_LEAVING_SQL).pluck().get(sheetId, userId, keep) as number | undefined;

// A window of rows with `cells` cells read from each (json_extract, a path each), and in mode rules whether each
// passes them (`pass`, 1 or 0).
export const windowSql = (cells: number, rules?: string): string => `SELECT rowid AS rid, id, row_index AS idx${
  Array.from({ length: cells }, (_, i) => `, json_extract(data, ?) AS c${i}`).join('')}${
  rules === undefined ? '' : `, (${rules}) IS 1 AS pass`} FROM rows
  WHERE sheet_id = ? AND user_id = ? AND row_index > ? AND row_index <= ? ORDER BY row_index LIMIT ?`;

export interface Window {
  // The finished rows found, at most `take`, by rowid, in row order.
  rowids: number[];
  // The last row looked at (the last taken when `take` was reached): the next window starts after it.
  last: number;
  // The window reached `upTo`: nothing after `last` may leave yet.
  end: boolean;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const inProgress = (v: unknown): boolean => [RUNNING_MARK, LIST_MARK].some(m => trimBlank(text(v)).startsWith(m));
const succeeded = (v: unknown): boolean => trimBlank(text(v)) !== '' && !holdsRunMarker(text(v));
// The mark the webhook stamps in its column on each row it adds (lib/webhook-ingest.ts).
const fromWebhook = (v: unknown): boolean => text(v).startsWith('📥');

// Up to `scan` rows after row `after` and up to row `upTo`, and the ones that may leave among them: finished, or
// in mode rules (`rules`) passing them. `runColumns`: the sheet's other run columns, checked for ⏳ and ➕ too.
export function finishedRows(
  sheet: { id: string; userId: string; raw: string }, holding: Holding[], success: string | null,
  after: number, upTo: number, scan: number, take: number, rules: CompiledFilter | null = null,
  runColumns: readonly string[] = [],
): Window {
  const watched = runColumns.filter(c => !holding.some(h => h.column === c));
  const columns = [sheet.raw, ...holding.map(h => h.column), ...(success === null ? [] : [success]), ...watched];
  const first = 1 + holding.length + (success === null ? 0 : 1);
  const rows = db.prepare(windowSql(columns.length, rules?.sql))
    .all(...columns.map(jsonPath), ...(rules?.params ?? []), sheet.id, sheet.userId, after, upTo, scan) as
    Array<Record<string, unknown>>;
  if (rows.length === 0) return { rowids: [], last: after, end: true };
  const queued = new Set<string>();
  if (holding.length > 0 && !rules) {
    const ids = db.prepare(`SELECT autorun_id || ' ' || row_id FROM autorun_pending
      WHERE autorun_id IN (SELECT value FROM json_each(?)) AND row_id IN (SELECT value FROM json_each(?))`).pluck()
      .all(JSON.stringify(holding.map(h => h.id)), JSON.stringify(rows.map(r => r.id))) as string[];
    for (const id of ids) queued.add(id);
  }
  const rowids: number[] = [];
  for (const r of rows) {
    const idx = r.idx as number;
    const still = holding.some((_, i) => inProgress(r[`c${i + 1}`]))
      || watched.some((_, i) => inProgress(r[`c${first + i}`]));
    const leaves = rules ? r.pass === 1 && !still
      : !still && holding.every(h => idx <= h.watermark && !queued.has(`${h.id} ${r.id as string}`))
        && (success === null || succeeded(r[`c${holding.length + 1}`]));
    if (fromWebhook(r.c0) && leaves) {
      rowids.push(r.rid as number);
      if (rowids.length === take) return { rowids, last: idx, end: false };
    }
  }
  return { rowids, last: rows[rows.length - 1].idx as number, end: rows.length < scan };
}
