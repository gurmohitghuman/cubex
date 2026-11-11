// transform_column: non-AI, zero-credit server-side cell transforms (extract,
// split, case, trim, to_number, template). The point: agents stop routing
// mechanical string ops through the LLM (paid) when a free tool exists. A call
// holds the sheet as its one heavy operation (lib/sheet-busy.ts: no sort, rename
// or run start meanwhile) and walks it a page at a time
// (column-transform-pages.ts). It writes at most TRANSFORM_MAX_ROWS rows or works
// TRANSFORM_MAX_CALL_MS; stopped with rows left, it answers next_cursor, and the
// same call with that cursor goes on after the last row looked at. A new target
// column is only added to column_order (the column registry): rows it wrote
// nothing in read it as empty, as with add_column. Bumps data_version (a value
// change) but never row_generation (no reorder or append, so what a row_index
// means is unchanged; bumping it would 409 in-flight autosaves). A cursor names
// the row_generation it was given at, so one from before a sort or a replace is
// refused rather than re-meant.
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
import { allOffError } from '../lib/row-filter/where';
import type { WhereItem } from '../lib/row-filter/where';
import {
  applyCellOp, applyTemplate, templateColumns, validateRegexPattern, type TransformOp,
} from '../lib/transform-ops';
import { walkTransform, type TransformWalk } from './column-transform-pages';

const CELL_OPS: TransformOp[] = ['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number'];
const BUSY_WHAT = 'transforming a column';
const CURSOR = /^(\d+):(-?\d+)$/;
export const TRANSFORM_STOPPED_NOTE = `Stopped at this call's limit (${TRANSFORM_MAX_ROWS.toLocaleString('en-US')} `
  + `rows written or about ${TRANSFORM_MAX_CALL_MS / 1000} seconds of work). The rows before next_cursor are done: `
  + 'call transform_column again with the same arguments and cursor set to next_cursor to go on.';

export interface TransformParams {
  sheetId: string;
  sourceColumn?: string;
  targetColumn: string;
  operation: TransformOp;
  pattern?: string;
  index?: number;
  template?: string;
  where?: WhereItem[];
  // next_cursor of the call before: go on after the last row it looked at.
  cursor?: string;
}

// next_cursor and note only when the call stopped with rows left.
export type TransformOutcome =
  | { ok: { updated: number; created_column: string | null; next_cursor?: string; note?: string } }
  | { fail: 'not_found' | 'invalid' | 'collision' | 'cap' | 'locked' | 'busy'; error: string };

type Fail = Extract<TransformOutcome, { fail: string }>;
type Plan = Omit<TransformWalk, 'sheetId' | 'userId'> & { targetExists: boolean; generation: number };

export async function transformColumn(userId: string, p: TransformParams): Promise<TransformOutcome> {
  const out = await withLiveSheetBusy(p.sheetId, userId, BUSY_WHAT, async (): Promise<TransformOutcome> => {
    const plan = planTransform(userId, p);
    if ('fail' in plan) return plan;
    if (!plan.targetExists) {
      db.transaction(() => appendColumnsToOrder(p.sheetId, userId, [plan.targetColumn])).immediate();
    }
    const walked = await walkTransform({ ...plan, sheetId: p.sheetId, userId });
    db.prepare(
      "UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    ).run(p.sheetId, userId);
    const ok = { updated: walked.updated, created_column: plan.targetExists ? null : plan.targetColumn };
    return walked.stoppedAfter === null ? { ok }
      : { ok: { ...ok, next_cursor: `${plan.generation}:${walked.stoppedAfter}`, note: TRANSFORM_STOPPED_NOTE } };
  });
  if (sheetGone(out)) return { fail: 'not_found', error: 'Sheet not found' };
  if ('busy' in out) return { fail: 'busy', error: out.busy };
  return out;
}

// What the call writes, checked with the sheet held (nothing can change it until the call ends).
function planTransform(userId: string, p: TransformParams): Plan | Fail {
  if (!CELL_OPS.includes(p.operation)) return { fail: 'invalid', error: `Unknown operation "${p.operation}".` };

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
  let after = -1;
  if (p.cursor !== undefined) {
    const m = CURSOR.exec(p.cursor);
    if (!m) return { fail: 'invalid', error: 'cursor must be the next_cursor a transform_column call answered.' };
    if (Number(m[1]) !== generation) {
      return { fail: 'invalid', error: 'The sheet\'s rows were sorted or replaced since that cursor was given. '
        + 'Run the transform again without cursor.' };
    }
    after = Number(m[2]);
  }
  const op = p.operation;
  const value = op === 'template'
    ? (data: Record<string, string>) => applyTemplate(p.template!, data)
    : (data: Record<string, string>) =>
      applyCellOp(op, cellOf(data, p.sourceColumn!), { pattern: p.pattern, index: p.index });
  return { filter, targetColumn, value, after, targetExists, generation };
}
