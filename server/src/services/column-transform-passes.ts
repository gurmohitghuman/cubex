// transform_column's passes (migration 056; services/column-transform.ts). A
// pass runs one transform into a column from the top of the sheet to its end,
// over one call or several. A sheet holds at most one unfinished pass per
// target column, its record keyed by the sheet and the target's name. The
// record is written in the transaction of each page that writes rows
// (column-transform-pages.ts) and when a call stops with rows left, so every
// next_cursor a call answers is the one its record holds, and it goes in the
// transaction of the page that ends the pass. While it is there, whatever
// stopped the pass (its call's limit, an error, a server that stopped during a
// call), every call that writes that column without the pass's cursor is
// refused, whatever its other arguments, so no operation reaches those rows
// twice; restart: true discards it. Where else it goes, and how it follows its
// column and sheet: column-transform-pass-moves.ts.
//
// A pass has a random id. The cursor is the row_generation, the last row_index
// looked at and 12 characters of a hash of the call and the pass id, so a
// cursor names one pass, and is taken only while it is the one its open pass
// last answered: an older or edited one is refused naming the pass's own, and
// one whose pass is over (it reached the end, was restarted, its column was
// deleted for good, its rows reordered) is refused, writing nothing. The hash
// names the target, wherever the call refers to it, as the pass first named it
// (the record keeps that name), so a cursor still goes on after the target's
// rename.
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../lib/db';
import { templateParts, type TransformOp } from '../lib/transform-ops';
import { groupItems, isGroup, isOrGroup, type WhereItem } from '../lib/row-filter/where';
import {
  MALFORMED, NOT_OPEN, OTHER_SHEET, inTrash, otherArgs, otherColumn, unfinishedWords,
} from './column-transform-pass-words';

const CURSOR = /^(\d+):(-?\d+):([0-9a-f]{12})$/;

export interface TransformCall {
  sheetId: string; targetColumn: string; operation: TransformOp;
  sourceColumn?: string; pattern?: string; index?: number; template?: string; where?: WhereItem[];
}

// The target, the operation with the parameters it uses, and where: what the
// call writes, whatever else it was sent (the sheet is the record's). Every
// reference to the target (a source, a template's {{column}}, a where's
// column) is hashed as the target under `targetAs`, so a template is hashed
// cut at its tokens, each name trimmed as the template reads it.
export function transformCallKey(c: TransformCall, targetAs: string): string {
  const col = (name: string | undefined) => (name === c.targetColumn ? { target: targetAs } : name);
  const whereOf = (items: WhereItem[]): unknown[] => items.map(item => (!isGroup(item) ? { ...item,
    column: col(item.column) } : { [isOrGroup(item) ? 'or' : 'and']: whereOf(groupItems(item)) }));
  const params = c.operation === 'template'
    ? { template: templateParts(c.template ?? '').map((part, i) => (i % 2 ? col(part.trim()) : part)) }
    : c.operation === 'regex_extract' ? { source: col(c.sourceColumn), pattern: c.pattern }
      : c.operation === 'split' ? { source: col(c.sourceColumn), pattern: c.pattern, index: c.index ?? 0 }
        : { source: col(c.sourceColumn) };
  const what = [{ target: targetAs }, c.operation, params, c.where?.length ? whereOf(c.where) : null];
  // Object keys sorted, so the same where sent with its keys in another order is the same call.
  const text = JSON.stringify(what, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
  return createHash('sha256').update(text).digest('hex');
}

export const newPassId = (): string => randomBytes(8).toString('hex');
export const passHash = (key: string, passId: string): string =>
  createHash('sha256').update(`${key}:${passId}`).digest('hex').slice(0, 12);
export const transformCursor = (generation: number, after: number, key: string, passId: string): string =>
  `${generation}:${after}:${passHash(key, passId)}`;

interface PassRecord { pass_id: string; cursor: string; rows_done: number; started_as: string }
// The refusal of a call while another pass into its column is unfinished.
export interface Unfinished { error: string; next_cursor: string; rows_done: number }
// Where a call starts: after its cursor, or from the top. `base`: the rows its
// pass wrote before it. `key`: its hash, the target under `targetAs`; `passId`
// its pass's, new for a pass from the top. `held`: the cursor the record holds.
export interface PassStart {
  after: number; base: number; key: string; targetAs: string; passId: string; held: string | null;
}
interface Scope { sheetId: string; userId: string; targetColumn: string; generation: number; targetExists: boolean }

const liveWhere = 'WHERE sheet_id = ? AND user_id = ? AND target_column = ? AND trash_id IS NULL';

// The column's unfinished pass. One whose column is gone or whose cursor no
// longer holds (its rows reordered since) can't be gone on with: it goes.
function unfinishedPass(s: Scope): PassRecord | undefined {
  const at = [s.sheetId, s.userId, s.targetColumn];
  const rec = db.prepare(`SELECT pass_id, cursor, rows_done, started_as FROM transform_passes ${liveWhere}`)
    .get(...at) as PassRecord | undefined;
  if (!rec || (s.targetExists && Number(CURSOR.exec(rec.cursor)?.[1]) === s.generation)) return rec;
  db.prepare(`DELETE FROM transform_passes ${liveWhere}`).run(...at);
  return undefined;
}

// The pass a cursor's hash names, wherever it is now (its cursors all end in it).
function passByHash(userId: string, hash: string) {
  return db.prepare(`SELECT sheet_id, target_column, trash_id FROM transform_passes
    WHERE user_id = ? AND substr(cursor, -12) = ? LIMIT 1`).get(userId, hash) as
    { sheet_id: string; target_column: string; trash_id: number | null } | undefined;
}

// A cursor with no open pass into this column: why, naming no cursor.
function noPassWords(s: Scope, cursor: string): string {
  const m = CURSOR.exec(cursor);
  if (!m) return MALFORMED;
  const other = passByHash(s.userId, m[3]);
  if (!other) return NOT_OPEN;
  if (other.sheet_id !== s.sheetId) return OTHER_SHEET;
  return other.trash_id !== null ? inTrash(other.target_column) : otherColumn(other.target_column, s.targetColumn);
}

// Where a call starts, or why it can't. restart: from the top, the column's
// unfinished pass discarded by its first page (passTracker).
export function startPass(s: Scope, call: TransformCall, opts: { cursor?: string; restart?: boolean }):
  PassStart | { invalid: string } | { unfinished: Unfinished } {
  const rec = unfinishedPass(s);
  const top = (): PassStart => ({ after: -1, base: 0, key: transformCallKey(call, s.targetColumn),
    targetAs: s.targetColumn, passId: newPassId(), held: null });
  if (opts.restart) return top();
  const refusal = rec && { unfinished: { error: unfinishedWords(s.targetColumn, rec.rows_done, rec.cursor),
    next_cursor: rec.cursor, rows_done: rec.rows_done } };
  if (opts.cursor === undefined) return refusal || top();
  if (!rec) return { invalid: noPassWords(s, opts.cursor) };
  // Only the cursor the pass last answered goes on: an older one would reach rows again, one edited ahead
  // would skip rows.
  if (opts.cursor !== rec.cursor) return refusal!;
  const key = transformCallKey(call, rec.started_as);
  if (passHash(key, rec.pass_id) !== CURSOR.exec(rec.cursor)![3]) return { invalid: otherArgs(s.targetColumn) };
  return { after: Number(CURSOR.exec(rec.cursor)![2]), base: rec.rows_done, key, targetAs: rec.started_as,
    passId: rec.pass_id, held: rec.cursor };
}

// The record's writes for one call, prepared once. page: in each page's
// transaction, the pass after it (`after` null: the pass is done); answers
// the cursor it wrote, or whether it deleted the record. A page that wrote no
// rows leaves the record as it was, so a where matching few rows doesn't write
// after every page. A pass started from the top drops, on its first page, the
// record of the pass restart discards. stop: the call stopped with rows left at
// `after`, in a transaction of its own; the cursor it answers. held: the cursor
// the record holds, as far as committed pages say (committed() after each).
export function passTracker(s: Scope & PassStart) {
  const at = [s.sheetId, s.userId, s.targetColumn];
  const drop = db.prepare(`DELETE FROM transform_passes ${liveWhere}`);
  const put = db.prepare(`INSERT INTO transform_passes (pass_id, sheet_id, user_id, target_column, started_as,
    call_key, cursor, rows_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (sheet_id, user_id, target_column) WHERE trash_id IS NULL DO UPDATE SET pass_id = excluded.pass_id,
    started_as = excluded.started_as, call_key = excluded.call_key, cursor = excluded.cursor,
    rows_done = excluded.rows_done, updated_at = datetime('now')`);
  let first = s.after === -1;
  let held = s.held;
  let pending: string | null | undefined;
  const write = (after: number, rows: number): string => {
    const cursor = transformCursor(s.generation, after, s.key, s.passId);
    put.run(s.passId, ...at, s.targetAs, s.key, cursor, rows);
    return cursor;
  };
  return {
    page(after: number | null, callRows: number, pageRows: number): boolean {
      const fresh = first;
      first = false;
      pending = undefined;
      if (after === null || (fresh && pageRows === 0)) {
        pending = null;
        return drop.run(...at).changes > 0;
      }
      if (pageRows === 0) return false;
      pending = write(after, s.base + callRows);
      return true;
    },
    committed(): void { if (pending !== undefined) held = pending; },
    stop(after: number, callRows: number): string {
      const cursor = transformCursor(s.generation, after, s.key, s.passId);
      return cursor === held ? cursor : write(after, s.base + callRows);
    },
    held: (): string | null => held,
  };
}
export type PassTracker = ReturnType<typeof passTracker>;
