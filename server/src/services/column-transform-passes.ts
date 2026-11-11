// transform_column's passes (migration 056; services/column-transform.ts). A
// pass runs one transform into a column from the top of the sheet to its end,
// over one call or several. A sheet holds at most one unfinished pass per
// target column: its record, keyed by the sheet and the target's name, is
// written in the transaction of each page that writes rows
// (column-transform-pages.ts) and goes in the transaction of the page that ends
// the pass. Stopped with rows written, whatever stopped it (its call's limit,
// an error, a server that stopped during a call), the pass stays unfinished:
// every call that writes that column without the pass's cursor is refused,
// whatever its other arguments, so no operation reaches those rows twice.
// restart: true discards it. A rename carries it along (column-rename.ts); it
// goes with its column (column-delete.ts), its sheet (trash-sheets.ts, and the
// foreign key) and any move of row_generation (a sort, a replace: migration
// 056's trigger), and a record found whose cursor no longer holds is deleted.
//
// The cursor is the row_generation, the last row_index looked at and the first
// 12 characters of the call's hash: a cursor from another sheet or another call
// is refused, and so is one from before a sort or a replace. The hash names the
// target, wherever the call refers to it, as the pass first named it (the
// record keeps that name), so a cursor still goes on after the target's rename.
import { createHash } from 'node:crypto';
import { db } from '../lib/db';
import { countOf } from '../lib/change-log';
import { templateParts, type TransformOp } from '../lib/transform-ops';
import { groupItems, isGroup, isOrGroup, type WhereItem } from '../lib/row-filter/where';

const CURSOR = /^(\d+):(-?\d+):([0-9a-f]{12})$/;
const short = (key: string): string => key.slice(0, 12);

export interface TransformCall {
  sheetId: string; targetColumn: string; operation: TransformOp;
  sourceColumn?: string; pattern?: string; index?: number; template?: string; where?: WhereItem[];
}

// The sheet, the target, the operation with the parameters it uses, and where:
// what the call writes, whatever else it was sent. Every reference to the
// target (a source, a template's {{column}}, a where's column) is hashed as
// the target under `targetAs`, so a template is hashed cut at its tokens, each
// name trimmed as the template reads it.
export function transformCallKey(c: TransformCall, targetAs: string): string {
  const col = (name: string | undefined) => (name === c.targetColumn ? { target: targetAs } : name);
  const whereOf = (items: WhereItem[]): unknown[] => items.map(item => (!isGroup(item) ? { ...item,
    column: col(item.column) } : { [isOrGroup(item) ? 'or' : 'and']: whereOf(groupItems(item)) }));
  const params = c.operation === 'template'
    ? { template: templateParts(c.template ?? '').map((part, i) => (i % 2 ? col(part.trim()) : part)) }
    : c.operation === 'regex_extract' ? { source: col(c.sourceColumn), pattern: c.pattern }
      : c.operation === 'split' ? { source: col(c.sourceColumn), pattern: c.pattern, index: c.index ?? 0 }
        : { source: col(c.sourceColumn) };
  const what = [c.sheetId, { target: targetAs }, c.operation, params, c.where?.length ? whereOf(c.where) : null];
  // Object keys sorted, so the same where sent with its keys in another order is the same call.
  const text = JSON.stringify(what, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
  return createHash('sha256').update(text).digest('hex');
}

export const transformCursor = (generation: number, after: number, key: string): string =>
  `${generation}:${after}:${short(key)}`;

const MALFORMED = 'cursor must be the next_cursor a transform_column call answered.';
const OTHER_CALL = 'This cursor belongs to another transform_column call (another sheet or other '
  + 'arguments). Call again without cursor to start over.';
const STALE = 'The sheet\'s rows were sorted or replaced since that cursor was given. '
  + 'Run the transform again without cursor.';

interface PassRecord { cursor: string; rows_done: number; started_as: string }
// The refusal of a call while another pass into its column is unfinished.
export interface Unfinished { error: string; next_cursor: string; rows_done: number }
// Where a call starts: after its cursor, or from the top. `base`: the rows its
// pass wrote before it. `key`: its hash, the target under `targetAs`.
export interface PassStart { after: number; base: number; key: string; targetAs: string }
interface Scope { sheetId: string; userId: string; targetColumn: string; generation: number; targetExists: boolean }

const recordWhere = 'WHERE sheet_id = ? AND user_id = ? AND target_column = ?';

// The column's unfinished pass. One whose column is gone or whose cursor no
// longer holds (a sort or a replace since) can't be gone on with: it goes.
function unfinishedPass(s: Scope): PassRecord | undefined {
  const at = [s.sheetId, s.userId, s.targetColumn];
  const rec = db.prepare(`SELECT cursor, rows_done, started_as FROM transform_passes ${recordWhere}`)
    .get(...at) as PassRecord | undefined;
  if (!rec || (s.targetExists && Number(CURSOR.exec(rec.cursor)?.[1]) === s.generation)) return rec;
  db.prepare(`DELETE FROM transform_passes ${recordWhere}`).run(...at);
  return undefined;
}

export function unfinishedWords(column: string, rows: number, cursor: string): string {
  return `An earlier transform_column pass into "${column}" is unfinished: it stopped after ${countOf(rows, 'row')}. `
    + `To finish it, call again with that pass's arguments and cursor set to "${cursor}"; starting over would `
    + 'apply the operation to those rows twice. To start over from the first row instead, applying the operation '
    + 'to every row again, call with restart: true and no cursor: do that when rows changed since the pass '
    + 'stopped, or to run the column with different arguments.';
}

// Where a call starts, or why it can't. restart: from the top, the column's
// unfinished pass discarded by its first page (passTracker).
export function startPass(s: Scope, call: TransformCall, opts: { cursor?: string; restart?: boolean }):
  PassStart | { invalid: string } | { unfinished: Unfinished } {
  const rec = unfinishedPass(s);
  const targetAs = (!opts.restart && rec?.started_as) || s.targetColumn;
  const key = transformCallKey(call, targetAs);
  const top = { after: -1, base: 0, key, targetAs };
  const refusal = rec && { unfinished: { error: unfinishedWords(s.targetColumn, rec.rows_done, rec.cursor),
    next_cursor: rec.cursor, rows_done: rec.rows_done } };
  if (opts.restart) return top;
  if (opts.cursor === undefined) return refusal || top;
  const m = CURSOR.exec(opts.cursor);
  if (!m) return { invalid: MALFORMED };
  const after = Number(m[2]);
  if (rec) {
    // Only the pass's own cursor goes on, from where it got: an earlier cursor of it would reach rows again.
    const own = CURSOR.exec(rec.cursor)!;
    const goesOn = m[3] === short(key) && own[3] === m[3] && Number(m[1]) === s.generation && after >= Number(own[2]);
    return goesOn ? { after, base: rec.rows_done, key, targetAs } : refusal!;
  }
  if (m[3] !== short(key)) return { invalid: OTHER_CALL };
  if (Number(m[1]) !== s.generation) return { invalid: STALE };
  return { after, base: 0, key, targetAs };
}

// The record's writes for one call, prepared once: in each page's transaction,
// the pass after it (`after` null: the pass is done); answers whether it wrote.
// A page that wrote no rows leaves the record as it was: its cursor then lags,
// which is safe (the pages after it changed nothing), and a where matching few
// rows doesn't write, and checkpoint, after every page. A pass started from the
// top drops, on its first page, the record of the pass restart discards.
export function passTracker(s: Scope & PassStart) {
  const at = [s.sheetId, s.userId, s.targetColumn];
  const drop = db.prepare(`DELETE FROM transform_passes ${recordWhere}`);
  const put = db.prepare(`INSERT INTO transform_passes (sheet_id, user_id, target_column, started_as, cursor,
    rows_done) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sheet_id, user_id, target_column) DO UPDATE SET
    started_as = excluded.started_as, cursor = excluded.cursor, rows_done = excluded.rows_done,
    updated_at = datetime('now')`);
  let first = s.after === -1;
  return (after: number | null, callRows: number, pageRows: number): boolean => {
    const fresh = first;
    first = false;
    if (after === null || (fresh && pageRows === 0)) return drop.run(...at).changes > 0;
    if (pageRows === 0) return false;
    put.run(...at, s.targetAs, transformCursor(s.generation, after, s.key), s.base + callRows);
    return true;
  };
}

// In the rename's transaction (services/column-rename.ts): the pass stays the column's.
export function renameTransformPasses(sheetId: string, userId: string, from: string, to: string): void {
  db.prepare(`UPDATE transform_passes SET target_column = ? ${recordWhere}`).run(to, sheetId, userId, from);
}

// In the delete's transaction (services/column-delete.ts): its cursor can't go on in a column made later.
export function deleteTransformPasses(sheetId: string, userId: string, column: string): void {
  db.prepare(`DELETE FROM transform_passes ${recordWhere}`).run(sheetId, userId, column);
}

// In the transaction that puts sheets in the trash (services/trash-sheets.ts).
export function dropSheetTransformPasses(sheetIds: string[], userId: string): void {
  db.prepare(`DELETE FROM transform_passes WHERE sheet_id IN (SELECT value FROM json_each(?)) AND user_id = ?`)
    .run(JSON.stringify(sheetIds), userId);
}

// The answer of a call that stopped on an error after writing pages: the error itself is logged, never shown.
export function stoppedOnErrorWords(rows: number, cursor: string, error: unknown): string {
  const busy = String((error as { code?: unknown } | null)?.code ?? '').startsWith('SQLITE_BUSY');
  return `Stopped on an error after ${countOf(rows, 'row')}: `
    + `${busy ? 'the sheet was busy (SQLITE_BUSY)' : 'something went wrong'}. Those rows are written. Call `
    + `transform_column again with the same arguments and cursor set to "${cursor}" to go on. Don't start over `
    + 'without cursor: that would apply the operation to those rows again.';
}
