// transform_column — non-AI, zero-credit server-side cell transforms (extract,
// split, case, trim, to_number, template). The point: agents stop routing
// mechanical string ops through the LLM (paid) when a free tool exists. Runs
// synchronously in one immediate txn under a wall-clock budget; bumps
// data_version (a value change) but NEVER row_generation (no reorder/append, so
// what a row_index means is unchanged — bumping it would 409 in-flight autosaves).
import { db } from '../lib/db';
import { TRANSFORM_MAX_WRITER_MS } from '../lib/api-v1-constants';
import {
  appendColumnsToOrder, getSheetColumns, jsonPath, parseRowData,
} from '../lib/sql-helpers';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';
import { getLockedRunColumns } from '../routes/sheets-shared';
import { validateRowConditions, rowPasses, cellOf, type RowCondition } from './row-selection';
import {
  applyCellOp, applyTemplate, validateRegexPattern, type TransformOp,
} from '../lib/transform-ops';

const CELL_OPS: TransformOp[] = ['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number'];

export interface TransformParams {
  sheetId: string;
  sourceColumn?: string;
  targetColumn: string;
  operation: TransformOp;
  pattern?: string;
  index?: number;
  template?: string;
  where?: RowCondition[];
}

export type TransformOutcome =
  | { ok: { updated: number; created_column: string | null } }
  | { fail: 'not_found' | 'invalid' | 'collision' | 'cap' | 'locked' | 'budget'; error: string };

class WriterBudgetError extends Error {}

export function transformColumn(userId: string, p: TransformParams): TransformOutcome {
  if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(p.sheetId, userId)) {
    return { fail: 'not_found', error: 'Sheet not found' };
  }
  if (!CELL_OPS.includes(p.operation)) return { fail: 'invalid', error: `Unknown operation "${p.operation}".` };

  // Per-op required params.
  if (p.operation === 'regex_extract') {
    const e = validateRegexPattern(p.pattern ?? ''); if (e) return { fail: 'invalid', error: e };
  } else if (p.operation === 'split') {
    if (!p.pattern) return { fail: 'invalid', error: 'split requires a pattern (the delimiter).' };
    if (p.index !== undefined && (!Number.isInteger(p.index) || p.index < 0)) return { fail: 'invalid', error: 'index must be a non-negative integer.' };
  } else if (p.operation === 'template') {
    if (!p.template) return { fail: 'invalid', error: 'template requires a template string.' };
  }

  const columns = getSheetColumns(p.sheetId, userId, false);
  // template pulls from the whole row; every other op reads source_column.
  if (p.operation !== 'template') {
    if (!p.sourceColumn) return { fail: 'invalid', error: 'source_column is required for this operation.' };
    if (!columns.includes(p.sourceColumn)) return { fail: 'invalid', error: `Source column "${p.sourceColumn}" not found.` };
  }
  if (p.where) {
    const invalid = validateRowConditions(columns, p.where);
    if (invalid) return { fail: 'invalid', error: invalid };
  }

  const nameCheck = sanitizeAndValidateColumnName(p.targetColumn);
  if ('error' in nameCheck) return { fail: 'invalid', error: nameCheck.error };
  const targetColumn = nameCheck.name;
  const targetExists = columns.includes(targetColumn);

  // Never transform INTO a column an active run owns — the runner writes there.
  const locked = getLockedRunColumns(p.sheetId, userId);
  if (locked.has(targetColumn)) return { fail: 'locked', error: `Column "${targetColumn}" is being written by an active run. Stop it first.` };
  if (p.sourceColumn && locked.has(p.sourceColumn)) return { fail: 'locked', error: `Column "${p.sourceColumn}" is being written by an active run. Stop it first.` };

  if (!targetExists) {
    // Creating a new column: case/token collision + cap (same as column-add).
    const collision = findColumnNameCollision(targetColumn, columns);
    if (collision) return { fail: 'collision', error: columnCollisionMessage(targetColumn, collision) };
    if (columns.length >= MAX_COLUMNS_PER_SHEET) {
      return { fail: 'cap', error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.` };
    }
  }

  const targetPath = jsonPath(targetColumn);
  const startedAt = Date.now();
  let updated = 0;
  try {
    db.transaction(() => {
      const setCell = db.prepare(
        "UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now') WHERE id = ?",
      );
      // A brand-new target column: initialize '' on every row first, so a
      // where-filtered transform leaves non-matching rows blank (not a ghost
      // column the read path prunes when zero rows back it).
      if (!targetExists) {
        for (const r of db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND user_id = ?').all(p.sheetId, userId) as Array<{ id: string }>) {
          setCell.run(targetPath, '', r.id);
        }
        appendColumnsToOrder(p.sheetId, userId, [targetColumn]);
      }
      // Materialize (not .iterate()): better-sqlite3 forbids writing while a
      // cursor is open on the same connection, and we json_set per row below.
      const rows = db.prepare('SELECT id, data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index ASC')
        .all(p.sheetId, userId) as Array<{ id: string; data: string }>;
      let seen = 0;
      for (const row of rows) {
        if ((++seen & 255) === 0 && Date.now() - startedAt > TRANSFORM_MAX_WRITER_MS) throw new WriterBudgetError();
        const data = parseRowData(row.data);
        if (p.where && p.where.length > 0 && !rowPasses(data, p.where)) continue;
        const value = p.operation === 'template'
          ? applyTemplate(p.template!, data)
          : applyCellOp(p.operation, cellOf(data, p.sourceColumn!), { pattern: p.pattern, index: p.index });
        setCell.run(targetPath, value, row.id);
        updated++;
      }
      db.prepare("UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(p.sheetId, userId);
    }).immediate();
  } catch (e) {
    if (e instanceof WriterBudgetError) return { fail: 'budget', error: 'Transform exceeded its time budget. Narrow it with a where filter and retry.' };
    throw e;
  }

  return { ok: { updated, created_column: targetExists ? null : targetColumn } };
}
