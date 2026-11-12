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
  applyCellOp, applyTemplate, templateColumns, validateRegexPattern, type TransformOp,
} from '../lib/transform-ops';
import { walkTransform, type TransformWalk, type WalkResult } from './column-transform-pages';
import { passTracker, startPass, type PassStart, type Unfinished } from './column-transform-passes';
import { stoppedOnErrorWords } from './column-transform-pass-words';
import { settle, stopAt } from './column-transform-end';
import { redactError } from '../lib/redact';

const CELL_OPS: TransformOp[] = ['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number'];
const BUSY_WHAT = 'transforming a column';
export const TRANSFORM_STOPPED_NOTE = `Stopped at this call's limit (${TRANSFORM_MAX_ROWS.toLocaleString('en-US')} `
  + `rows written or about ${TRANSFORM_MAX_CALL_MS / 1000} seconds of work). The rows before next_cursor are done: `
  + 'call transform_column again with the same arguments and cursor set to next_cursor to go on.';

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
type Plan = Omit<TransformWalk, 'sheetId' | 'userId' | 'after' | 'track'> & PassStart
  & { targetExists: boolean; generation: number };

export async function transformColumn(userId: string, p: TransformParams): Promise<TransformOutcome> {
  const out = await withLiveSheetBusy(p.sheetId, userId, BUSY_WHAT, async (): Promise<TransformOutcome> => {
    const plan = planTransform(userId, p);
    if ('fail' in plan || 'unfinished' in plan) return plan;
    const track = passTracker({ ...plan, sheetId: p.sheetId, userId });
    let added = false;
    let walked: WalkResult | undefined;
    try {
      if (!plan.targetExists) {
        db.transaction(() => appendColumnsToOrder(p.sheetId, userId, [plan.targetColumn])).immediate();
        added = true;
      }
      walked = await walkTransform({ ...plan, sheetId: p.sheetId, userId, track });
    } finally {
      // Open grids and readers learn of a column added or pages written, whatever stopped the call.
      if ((walked !== undefined && !walked.failed) || added || (walked?.pages ?? 0) > 0) settle(p.sheetId, userId);
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
    // Stopped with rows left, even before writing a row: the record holds the cursor it answers.
    return { ok: { ...ok, next_cursor: stopAt(track, walked.stoppedAfter, walked.updated),
      note: TRANSFORM_STOPPED_NOTE } };
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
  // template pulls from the whole row; every other op reads source_column.
  if (p.operation !== 'template') {
    if (!p.sourceColumn) return { fail: 'invalid', error: 'source_column is required for this operation.' };
    if (!columns.includes(p.sourceColumn)) {
      return { fail: 'invalid', error: `Source column "${p.sourceColumn}" not found.` };
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

  const generation = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(p.sheetId, userId) as number;
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
