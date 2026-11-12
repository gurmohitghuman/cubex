// Over 200 lines: one call, its checks in the order they answer and its walk, read top to bottom.
// transform_column: non-AI, zero-credit server-side cell transforms (extract,
// split, case, trim, to_number, template), so agents stop routing mechanical
// string ops through a paid model. A call holds the sheet as its one heavy
// operation (lib/sheet-busy.ts) and walks it a page at a time
// (column-transform-pages.ts), writing at most TRANSFORM_MAX_ROWS rows or
// working TRANSFORM_MAX_CALL_MS; stopped with rows left, it answers next_cursor
// (or, a page failing after others committed, `stopped` with the rows written).
// Until a pass gets to the end, whatever stopped it, a call into its column
// without its cursor answers `unfinished`; restart: true starts over, and a
// cursor goes on only while it is the one its open pass last answered
// (column-transform-passes.ts). A new target column is only added to
// column_order: rows it wrote nothing in read it as empty, as with add_column.
// Bumps data_version, never row_generation (what a row_index means is
// unchanged; bumping it would 409 in-flight autosaves).
import { db } from '../lib/db';
import { TRANSFORM_MAX_CALL_MS, TRANSFORM_MAX_ROWS } from '../lib/api-v1-constants';
import { appendColumnsToOrder, getSheetColumns } from '../lib/sql-helpers';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';
import { runHeldColumns } from '../lib/run-locked-columns';
import { heldColumnWords } from '../lib/run-held-words';
import { cellOf } from '../lib/row-cell';
import { sheetGone, withLiveSheetBusy } from '../lib/sheet-busy';
import { prepareWhere } from './row-filter';
import { allOffError, type WhereItem } from '../lib/row-filter/where';
import {
  applyCellOp, applyTemplate, templateColumns, templateRenamed, validateRegexPattern, type TransformOp,
} from '../lib/transform-ops';
import { walkTransform, type TransformWalk, type WalkResult } from './column-transform-pages';
import { passStartedAs, passTracker, startPass, type PassStart, type Unfinished } from './column-transform-passes';
import { stoppedOnErrorWords, targetRenamedWords } from './column-transform-pass-words';
import { settle, stopAt } from './column-transform-end';
import { inWalTurn, walTurnCheck } from '../lib/wal-turn';
import { redactError } from '../lib/redact';

const CELL_OPS: TransformOp[] = ['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number'];
const BUSY_WHAT = 'transforming a column';
export const TRANSFORM_STOPPED_NOTE = `Stopped at this call's limit (${TRANSFORM_MAX_ROWS.toLocaleString('en-US')} `
  + `rows written or about ${TRANSFORM_MAX_CALL_MS / 1000} seconds of work). The rows before next_cursor are done: `
  + 'call transform_column again with the same arguments and cursor set to next_cursor to go on.';
// A call whose wait for the WAL to be copied back, before its first page, took all its time.
export const TRANSFORM_WAITED_NOTE = 'Waited for the database file to catch up with earlier writes for all of this '
  + `call's time (about ${TRANSFORM_MAX_CALL_MS / 1000} seconds), so it wrote no rows. Nothing is lost: next_cursor `
  + 'goes on from where the pass is. Call transform_column again with the same arguments and cursor set to it.';

const RESTART_WITH_CURSOR = 'restart and cursor don\'t go together: restart: true starts the column over from '
  + 'the first row, cursor goes on from where a call stopped. Send one of them.';

export interface TransformParams {
  sheetId: string;
  sourceColumn?: string;
  targetColumn: string;
  operation: TransformOp;
  pattern?: string;
  index?: number;
  template?: string;
  where?: WhereItem[];
  // The latest next_cursor of its pass: go on after the last row it looked at.
  cursor?: string;
  // Start over from the first row, discarding the column's unfinished pass.
  restart?: boolean;
}

// next_cursor and note only when the call stopped with rows left. `stopped`: a
// page failed after others committed (rows_done: the pass's rows written so far).
// `unfinished`: refused, another pass into the column is unfinished.
export type TransformOutcome =
  | { ok: { updated: number; created_column: string | null; next_cursor?: string; note?: string } }
  | { stopped: { error: string; next_cursor: string; rows_done: number } }
  | { unfinished: Unfinished }
  | { fail: 'not_found' | 'invalid' | 'collision' | 'cap' | 'locked' | 'busy'; error: string };

type Fail = Extract<TransformOutcome, { fail: string }>;
type Plan = Omit<TransformWalk, 'sheetId' | 'userId' | 'after' | 'track' | 'until'> & PassStart
  & { targetExists: boolean; generation: number };

export async function transformColumn(userId: string, p: TransformParams): Promise<TransformOutcome> {
  const out = await withLiveSheetBusy(p.sheetId, userId, BUSY_WHAT, async (): Promise<TransformOutcome> => {
    const plan = planTransform(userId, p);
    if ('fail' in plan || 'unfinished' in plan) return plan;
    const track = passTracker({ ...plan, sheetId: p.sheetId, userId });
    // Its writes, the pages' included, are made in turn with the checkpoint worker's (lib/wal-turn.ts).
    const until = Date.now() + TRANSFORM_MAX_CALL_MS;
    let added = false;
    let walked: WalkResult | undefined;
    try {
      if (!plan.targetExists) {
        const add = db.transaction(() => {
          walTurnCheck();
          appendColumnsToOrder(p.sheetId, userId, [plan.targetColumn]);
        });
        await inWalTurn(() => add.immediate(), until, true);
        added = true;
      }
      walked = await walkTransform({ ...plan, sheetId: p.sheetId, userId, track, until });
    } finally {
      // Open grids and readers learn of a column added or pages written, whatever stopped the call.
      if ((walked !== undefined && !walked.failed) || added || (walked?.pages ?? 0) > 0) {
        await settle(p.sheetId, userId, until);
      }
    }
    const rows = plan.base + walked.updated;
    if (walked.failed) {
      // A first page that failed, or a pass with no row written yet: the call fails as any other.
      const next = track.held();
      if (walked.pages === 0 || rows === 0 || next === null) throw walked.failed.error;
      console.error(`transform_column on sheet ${p.sheetId} stopped on an error after ${rows} rows:`,
        redactError(walked.failed.error));
      // The cursor its record holds: after the last page that wrote (the pages after it wrote nothing).
      return { stopped: { error: stoppedOnErrorWords(rows, next, walked.failed.error), next_cursor: next,
        rows_done: rows } };
    }
    const ok = { updated: walked.updated, created_column: plan.targetExists ? null : plan.targetColumn };
    if (walked.stoppedAfter === null) return { ok };
    // Stopped with rows left, even before writing a row: the record holds the cursor it answers. Stopped before
    // its first page, only its wait for the WAL took its time.
    return { ok: { ...ok, next_cursor: await stopAt(track, walked.stoppedAfter, walked.updated, until),
      note: walked.pages === 0 ? TRANSFORM_WAITED_NOTE : TRANSFORM_STOPPED_NOTE } };
  });
  if (sheetGone(out)) return { fail: 'not_found', error: 'Sheet not found' };
  if ('busy' in out) return { fail: 'busy', error: out.busy };
  return out;
}

// What the call writes, checked with the sheet held (nothing can change it until the call ends).
function planTransform(userId: string, p: TransformParams): Plan | Fail | { unfinished: Unfinished } {
  if (!CELL_OPS.includes(p.operation)) return { fail: 'invalid', error: `Unknown operation "${p.operation}".` };
  if (p.restart && p.cursor !== undefined) return { fail: 'invalid', error: RESTART_WITH_CURSOR };

  // Per-op required params.
  if (p.operation === 'regex_extract') {
    const e = validateRegexPattern(p.pattern ?? ''); if (e) return { fail: 'invalid', error: e };
  } else if (p.operation === 'split') {
    if (!p.pattern) return { fail: 'invalid', error: 'split requires a pattern (the delimiter).' };
    if (p.index !== undefined && (!Number.isInteger(p.index) || p.index < 0)) {
      return { fail: 'invalid', error: 'index must be a non-negative integer.' };
    }
  } else if (p.operation === 'template') {
    if (!p.template) return { fail: 'invalid', error: 'template requires a template string.' };
  }

  const columns = getSheetColumns(p.sheetId, userId, false);
  // template pulls from the whole row; every other op reads source_column. Each column a call reads must be
  // the sheet's (where's too: prepareWhere), or it would write from an empty value (a column renamed since a
  // pass stopped, for one).
  if (p.operation !== 'template') {
    if (!p.sourceColumn) return { fail: 'invalid', error: 'source_column is required for this operation.' };
    if (!columns.includes(p.sourceColumn)) {
      return { fail: 'invalid', error: `Source column "${p.sourceColumn}" not found.` };
    }
  } else {
    const missing = templateColumns(p.template!).filter(c => !columns.includes(c));
    if (missing.length > 0) {
      // A cursor's pass answers first, read only: a target renamed since is named as it is now.
      const pass = p.cursor === undefined || p.restart ? null : peekPass(userId, p, columns);
      if (pass) return targetReadAsStarted(userId, p, columns, missing) ?? pass;
      const named = missing.map(c => `"${c}"`).join(', ');
      return { fail: 'invalid', error: `Template column${missing.length === 1 ? '' : 's'} ${named} not found.` };
    }
  }
  let filter = { sql: '1', params: [] as unknown[] };
  if (p.where?.length) {
    const prepared = prepareWhere(p.sheetId, userId, p.where, columns);
    if ('error' in prepared) return { fail: 'invalid', error: prepared.error };
    const off = allOffError(p.where, 'leave where out to transform every row');
    if (off) return { fail: 'invalid', error: off };
    filter = prepared.ok.filter;
  }

  const nameCheck = sanitizeAndValidateColumnName(p.targetColumn);
  if ('error' in nameCheck) return { fail: 'invalid', error: nameCheck.error };
  const targetColumn = nameCheck.name;
  const targetExists = columns.includes(targetColumn);

  // Never transform INTO or FROM a column an active run owns (the runner writes there), or one a stopped
  // or failed run is still putting back (its ⏳ cells stay until its clear reaches them). A template reads
  // every {{column}} it names; every other operation, its source column.
  const held = runHeldColumns(p.sheetId, userId, { clearing: true });
  const reads = p.operation === 'template' ? templateColumns(p.template!) : [];
  const busy = [targetColumn, ...(p.sourceColumn ? [p.sourceColumn] : []), ...reads].find(c => held.has(c));
  if (busy !== undefined) return { fail: 'locked', error: heldColumnWords(busy, held.get(busy)!) };

  if (!targetExists) {
    // Creating a new column: case/token collision + cap (same as column-add).
    const collision = findColumnNameCollision(targetColumn, columns);
    if (collision) return { fail: 'collision', error: columnCollisionMessage(targetColumn, collision) };
    if (columns.length >= MAX_COLUMNS_PER_SHEET) {
      return {
        fail: 'cap',
        error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.`,
      };
    }
  }

  const generation = generationOf(p.sheetId, userId);
  const start = startPass({ sheetId: p.sheetId, userId, targetColumn, generation, targetExists },
    { ...p, targetColumn }, { cursor: p.cursor, restart: p.restart });
  if ('invalid' in start) return { fail: 'invalid', error: start.invalid };
  if ('unfinished' in start) return start;
  const op = p.operation;
  const value = op === 'template'
    ? (data: Record<string, string>) => applyTemplate(p.template!, data)
    : (data: Record<string, string>) =>
      applyCellOp(op, cellOf(data, p.sourceColumn!), { pattern: p.pattern, index: p.index });
  return { filter, targetColumn, value, ...start, targetExists, generation };
}

const generationOf = (sheetId: string, userId: string): number =>
  db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?').pluck().get(sheetId, userId) as number;

// The refusal of the pass a call's cursor names, writing nothing; null when it would go on.
function peekPass(userId: string, p: TransformParams, columns: string[]): Fail | { unfinished: Unfinished } | null {
  const name = sanitizeAndValidateColumnName(p.targetColumn);
  if ('error' in name) return null;
  const start = startPass({ sheetId: p.sheetId, userId, targetColumn: name.name,
    generation: generationOf(p.sheetId, userId), targetExists: columns.includes(name.name) },
  { ...p, targetColumn: name.name }, { cursor: p.cursor, peek: true });
  if ('invalid' in start) return { fail: 'invalid', error: start.invalid };
  return 'unfinished' in start ? start : null;
}

// A cursor's template whose only missing column is the name its pass first named the target by (renamed since):
// when the same call naming the target as it is now would go on, the refusal says so, not to start over.
function targetReadAsStarted(userId: string, p: TransformParams, columns: string[], missing: string[]): Fail | null {
  const target = sanitizeAndValidateColumnName(p.targetColumn);
  if ('error' in target || missing.length !== 1) return null;
  const was = passStartedAs(p.sheetId, userId, target.name);
  if (was !== missing[0]) return null;
  const now = { ...p, template: templateRenamed(p.template!, was, target.name) };
  return peekPass(userId, now, columns) === null ? { fail: 'invalid', error: targetRenamedWords(was, target.name) }
    : null;
}
