// Search in the grid: the next (or previous) cell whose text contains what was
// typed, in row order then column order, through the active view (its filters
// pick the rows, its hidden columns are skipped), and how many cells match,
// up to SEARCH_COUNT_CAP. The grid holds only a window of rows, so both walk
// the sheet here, a slice at a time between other requests
// (lib/sheet-slices.ts); SQLite drops the rows that can't match
// (sheet-search-plan.ts) and only the rest are read in JavaScript.
import { db } from '../lib/db';
import { sliceSql, walkSlices } from '../lib/sheet-slices';
import { SEARCH_COUNT_CAP } from '../lib/constants-query';
import type { CompiledFilter } from '../lib/row-filter/sql';
import {
  firstHit, hitCount, planSearch, rowColumns, type PlanFail, type SearchPlan, type Side,
} from './sheet-search-plan';

export interface SearchCell { row: number; column: string }
export interface Found extends SearchCell { position: number }
type Versions = SearchPlan['versions'];

export interface FindInput {
  q: unknown;
  viewId?: unknown;
  // Where the search goes on from (the current match, or the focused cell);
  // position: its row's place in the view, read at `versions`.
  from?: SearchCell & { position?: number };
  versions?: Versions;
  // from's own cell may match (a new search starting at the focused cell).
  inclusive?: boolean;
  back?: boolean;
  stop?: () => boolean;
}
export type FindOutcome = { ok: { match: Found | null; wrapped: boolean } & Versions } | PlanFail | { stopped: true };
export type CountOutcome =
  | { ok: { total: number; capped: boolean; before: number | null } & Versions } | PlanFail | { stopped: true };

const EVERY_ROW: CompiledFilter = { sql: '1', params: [] };
type Row = { row_index: number; data: string };
const STOPPED = Symbol('stopped');

// The rows of one slice that might match, in the walk's order.
function candidates(plan: SearchPlan, desc: boolean) {
  const f = plan.filter ?? EVERY_ROW;
  const order = desc ? 'row_index DESC' : 'row_index ASC';
  const stmt = db.prepare(`SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND ${sliceSql(desc)}
    AND ${plan.prefilter.sql} AND (${f.sql}) ORDER BY ${order}`);
  return (sheetId: string, userId: string, a: number, b: number) =>
    stmt.iterate(sheetId, userId, a, b, ...plan.prefilter.params, ...f.params) as IterableIterator<Row>;
}

async function findOnce(
  sheetId: string, userId: string, plan: SearchPlan, input: FindInput,
): Promise<{ hit: SearchCell | null; wrapped: boolean } | typeof STOPPED> {
  const back = !!input.back, from = input.from;
  const at = from ? plan.columns.indexOf(from.column) : -1;
  // Walk from `start` (exclusive); with `until`, only up to that row, whose
  // columns on `until.side` of the start column are searched.
  const scan = async (start: number | undefined, until?: { row: number; side: Side }) => {
    const rows = candidates(plan, back), order = rowColumns(plan, back);
    let hit: SearchCell | null = null;
    const walk = { from: start, desc: back, sliced: true, stop: input.stop };
    const finished = await walkSlices(sheetId, userId, walk, (a, b) => {
      for (const r of rows(sheetId, userId, a, b)) {
        if (until && (back ? r.row_index < until.row : r.row_index > until.row)) return true;
        const edge = until && r.row_index === until.row;
        const cols = edge ? rowColumns(plan, back, { index: at, side: until.side }) : order;
        const i = firstHit(plan, r.data, cols);
        if (i >= 0) { hit = { row: r.row_index, column: plan.columns[i] }; return true; }
      }
      return !!until && (back ? a <= until.row : b >= until.row);
    });
    return finished ? hit : STOPPED;
  };
  if (!from) {
    const hit = await scan(undefined);
    return hit === STOPPED ? STOPPED : { hit, wrapped: false };
  }
  // The start row's other columns, then the rows after it (before it, going back).
  const f = plan.filter ?? EVERY_ROW;
  const own = db.prepare(`SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index = ? AND (${f.sql})`)
    .pluck().get(sheetId, userId, from.row, ...f.params) as string | undefined;
  const side: Side = back ? (input.inclusive ? 'to' : 'before') : (input.inclusive ? 'from' : 'after');
  const i = own === undefined ? -1 : firstHit(plan, own, rowColumns(plan, back, { index: at, side }));
  if (i >= 0) return { hit: { row: from.row, column: plan.columns[i] }, wrapped: false };
  const next = await scan(from.row);
  if (next === STOPPED || next) return next === STOPPED ? STOPPED : { hit: next, wrapped: false };
  // None: from the other end round to the start row, its own cell included.
  const wrap = await scan(undefined, { row: from.row, side: back ? 'from' : 'to' });
  return wrap === STOPPED ? STOPPED : { hit: wrap, wrapped: wrap !== null };
}

// Rows the filter passes with lo < row_index < hi (null: stopped).
async function countBetween(
  sheetId: string, userId: string, filter: CompiledFilter, lo: number, hi: number, stop?: () => boolean,
): Promise<number | null> {
  const st = db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ? AND ${sliceSql()}
    AND row_index < ? AND (${filter.sql})`).pluck();
  let n = 0;
  const finished = await walkSlices(sheetId, userId, { from: lo, sliced: true, stop }, (a, b) => {
    n += st.get(sheetId, userId, a, b, hi, ...filter.params) as number;
    return b >= hi;
  });
  return finished ? n : null;
}

// The match's row's place in the view (0 = its first row): counted on from
// the start's known place when the sheet hasn't changed since it was read,
// else from the top.
async function positionOf(
  sheetId: string, userId: string, plan: SearchPlan, input: FindInput, hit: SearchCell, wrapped: boolean,
): Promise<number | null> {
  if (!plan.filter) {
    return db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index < ?').pluck()
      .get(sheetId, userId, hit.row) as number;
  }
  const from = input.from, v = input.versions;
  const known = from?.position !== undefined && !wrapped && v?.data_version === plan.versions.data_version
    && v?.row_generation === plan.versions.row_generation;
  if (!known) return countBetween(sheetId, userId, plan.filter, Number.MIN_SAFE_INTEGER, hit.row, input.stop);
  if (hit.row === from!.row) return from!.position!;
  const lo = Math.min(hit.row, from!.row), hi = Math.max(hit.row, from!.row);
  const between = await countBetween(sheetId, userId, plan.filter, lo, hi, input.stop);
  if (between === null) return null;
  return Math.max(0, hit.row > from!.row ? from!.position! + between + 1 : from!.position! - between - 1);
}

// Always a slice at a time, even while a heavy operation moves rows (reading
// the sheet in one go then would hold the server on every keystroke): a sort
// or a replace moves row_generation, and the app then searches again.
export async function findMatch(sheetId: string, userId: string, input: FindInput): Promise<FindOutcome> {
  const plan = planSearch(sheetId, userId, input.q, input.viewId);
  if ('fail' in plan) return plan;
  const found = await findOnce(sheetId, userId, plan, input);
  if (found === STOPPED) return { stopped: true };
  if (!found.hit) return { ok: { match: null, wrapped: false, ...plan.versions } };
  const position = await positionOf(sheetId, userId, plan, input, found.hit, found.wrapped);
  if (position === null) return { stopped: true };
  return { ok: { match: { ...found.hit, position }, wrapped: found.wrapped, ...plan.versions } };
}

// How many cells match, up to SEARCH_COUNT_CAP, and how many of them come
// before `at` (the current match: "3 of 1,240"), when that is within the cap.
export async function countMatches(
  sheetId: string, userId: string, input: { q: unknown; viewId?: unknown; at?: SearchCell; stop?: () => boolean },
): Promise<CountOutcome> {
  const plan = planSearch(sheetId, userId, input.q, input.viewId);
  if ('fail' in plan) return plan;
  const at = input.at, col = at ? plan.columns.indexOf(at.column) : -1;
  const rows = candidates(plan, false), order = rowColumns(plan, false);
  let total = 0, before: number | null = null, capped = false;
  const finished = await walkSlices(sheetId, userId, { sliced: true, stop: input.stop }, (a, b) => {
    for (const r of rows(sheetId, userId, a, b)) {
      if (at && before === null && r.row_index > at.row) before = total;
      if (at && r.row_index === at.row) {
        before = total + hitCount(plan, r.data, rowColumns(plan, false, { index: col, side: 'before' }));
      }
      total += hitCount(plan, r.data, order);
      if (total > SEARCH_COUNT_CAP) { capped = true; return true; }
    }
    return false;
  });
  if (!finished) return { stopped: true };
  if (at && before === null && !capped) before = total;
  return { ok: { total: Math.min(total, SEARCH_COUNT_CAP), capped, before, ...plan.versions } };
}
