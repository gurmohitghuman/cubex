// transform_column's passes (migration 056; services/column-transform.ts). A
// pass runs one transform from the top of the sheet to its end, over one call
// or several. Its record, keyed by the sheet and a hash of the call's
// arguments, is written in the transaction of each page that writes rows
// (column-transform-pages.ts), and goes in the transaction of the page that
// ends the pass. A call stopped at its limit closes it (open 0). A call that
// stopped on an error, or a server that stopped during a call, leaves it open
// with the cursor after the last page that wrote rows: the same call without
// cursor is refused, so a pass never applies its operation twice to rows it
// already wrote. A record from another row_generation (a sort or a replace
// since), or for a target column that is gone, is no longer heeded.
//
// The cursor is the row_generation, the last row_index looked at and the first
// 12 characters of the call's hash: a cursor from another sheet or another
// call is refused, and so is one from before a sort or a replace.
import { createHash } from 'node:crypto';
import { db } from '../lib/db';
import { countOf } from '../lib/change-log';
import type { TransformOp } from '../lib/transform-ops';
import type { WhereItem } from '../lib/row-filter/where';

const CURSOR = /^(\d+):(-?\d+):([0-9a-f]{12})$/;
const short = (key: string): string => key.slice(0, 12);

export interface TransformCall {
  sheetId: string; targetColumn: string; operation: TransformOp;
  sourceColumn?: string; pattern?: string; index?: number; template?: string; where?: WhereItem[];
}

// The sheet, the target, the operation with the parameters it uses, and where:
// what the call writes, whatever else it was sent.
export function transformCallKey(c: TransformCall): string {
  const params = c.operation === 'template' ? { template: c.template }
    : c.operation === 'regex_extract' ? { source: c.sourceColumn, pattern: c.pattern }
      : c.operation === 'split' ? { source: c.sourceColumn, pattern: c.pattern, index: c.index ?? 0 }
        : { source: c.sourceColumn };
  const what = [c.sheetId, c.targetColumn, c.operation, params, c.where?.length ? c.where : null];
  // Object keys sorted, so the same where sent with its keys in another order is the same call.
  const text = JSON.stringify(what, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
  return createHash('sha256').update(text).digest('hex');
}

export const transformCursor = (generation: number, after: number, key: string): string =>
  `${generation}:${after}:${short(key)}`;

const OTHER_CALL_CURSOR = 'This cursor belongs to another transform_column call (another sheet or other '
  + 'arguments). Call again without cursor to start over.';

interface PassRecord { cursor: string; rows_done: number; open: number }
export interface PassStart { after: number; base: number; open: boolean }
interface Scope { sheetId: string; userId: string; key: string; generation: number }

// Where a call starts: after its cursor, or from the top. `base`: the rows its
// pass wrote before it. `open`: the pass had stopped on an error.
export function startPass(s: Scope & { targetExists: boolean }, cursor?: string): PassStart | { error: string } {
  const rec = s.targetExists ? db.prepare(`SELECT cursor, rows_done, open FROM transform_passes
    WHERE sheet_id = ? AND user_id = ? AND call_key = ?`).get(s.sheetId, s.userId, s.key) as PassRecord | undefined
    : undefined;
  const live = rec && Number(CURSOR.exec(rec.cursor)?.[1]) === s.generation ? rec : undefined;
  if (cursor === undefined) {
    if (live?.open) {
      return { error: `An earlier transform_column call with these arguments stopped on an error after `
        + `${countOf(live.rows_done, 'row')}. Call again with cursor set to "${live.cursor}" to finish it; `
        + 'starting over would apply the operation to those rows twice.' };
    }
    return { after: -1, base: 0, open: false };
  }
  const m = CURSOR.exec(cursor);
  if (!m) return { error: 'cursor must be the next_cursor a transform_column call answered.' };
  if (m[3] !== short(s.key)) return { error: OTHER_CALL_CURSOR };
  if (Number(m[1]) !== s.generation) {
    return { error: 'The sheet\'s rows were sorted or replaced since that cursor was given. '
      + 'Run the transform again without cursor.' };
  }
  return { after: Number(m[2]), base: live?.rows_done ?? 0, open: !!live?.open };
}

// The record's writes for one call, prepared once. page(): in each page's
// transaction, the pass after it (`after` null: the pass is done); answers
// whether it wrote. A page that wrote no rows leaves the record as it was: its
// cursor then lags, which is safe (the pages after it changed nothing), and a
// where matching few rows doesn't write, and checkpoint, after every page. A
// pass started without cursor drops, on its first page, a record left by an
// earlier one (closed, or no longer heeded), so its rows_done counts its own.
// atLimit(): the call stopped at its limit.
export function passTracker(s: Scope & PassStart) {
  const where = 'WHERE sheet_id = ? AND user_id = ? AND call_key = ?';
  const drop = db.prepare(`DELETE FROM transform_passes ${where}`);
  const put = db.prepare(`INSERT INTO transform_passes (sheet_id, user_id, call_key, cursor, rows_done, open)
    VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (sheet_id, user_id, call_key) DO UPDATE SET cursor = excluded.cursor,
    rows_done = excluded.rows_done, open = 1, updated_at = datetime('now')`);
  const close = db.prepare(`UPDATE transform_passes SET open = 0, updated_at = datetime('now') ${where}`);
  let first = s.after === -1;
  return {
    page(after: number | null, callRows: number, pageRows: number): boolean {
      const fresh = first;
      first = false;
      if (after === null || (fresh && pageRows === 0)) return drop.run(s.sheetId, s.userId, s.key).changes > 0;
      if (pageRows === 0) return false;
      put.run(s.sheetId, s.userId, s.key, transformCursor(s.generation, after, s.key), s.base + callRows);
      return true;
    },
    // Unless a call before had stopped on an error: that pass stays open until a call finishes it.
    atLimit(): void { if (!s.open) close.run(s.sheetId, s.userId, s.key); },
  };
}

// The answer of a call that stopped on an error after writing pages: the error itself is logged, never shown.
export function stoppedOnErrorWords(rows: number, cursor: string, error: unknown): string {
  const busy = String((error as { code?: unknown } | null)?.code ?? '').startsWith('SQLITE_BUSY');
  return `Stopped on an error after ${countOf(rows, 'row')}: `
    + `${busy ? 'the sheet was busy (SQLITE_BUSY)' : 'something went wrong'}. Those rows are written. Call `
    + `transform_column again with the same arguments and cursor set to "${cursor}" to go on. Don't start over `
    + 'without cursor: that would apply the operation to those rows again.';
}
