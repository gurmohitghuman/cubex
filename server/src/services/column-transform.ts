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
import { cellOf } from './row-selection';
import { prepareWhere } from './row-filter';
import type { WhereItem } from '../lib/row-filter/where';
import {
  applyCellOp, applyTemplate, validateRegexPattern, type TransformOp,
} from '../lib/transform-ops';
import { markAutorunInputs } from '../lib/autorun-mark';

const CELL_OPS: TransformOp[] = ['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number'];

export interface TransformParams {
  sheetId: string;
  sourceColumn?: string;
  targetColumn: string;
  operation: TransformOp;
  pattern?: string;
  index?: number;
  template?: string;
  where?: WhereItem[];
}

export type TransformOutcome =
  | { ok: { updated: number; created_column: string | null } }
  | { fail: 'not_found' | 'invalid' | 'collision' | 'cap' | 'locked' | 'budget'; error: string };

class WriterBudgetError extends Error {}

export function transformColumn(userId: string, p: TransformParams): TransformOutcome {
  if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(p.sheetId, userId)) {
    return { fail: 'not_found', error: 'Sheet not found' };
  }
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
    filter = prepared.ok.filter;
  }

  const nameCheck = sanitizeAndValidateColumnName(p.targetColumn);
  if ('error' in nameCheck) return { fail: 'invalid', error: nameCheck.error };
  const targetColumn = nameCheck.name;
  const targetExists = columns.includes(targetColumn);

  // Never transform INTO a column an active run owns — the runner writes there.
  const locked = getLockedRunColumns(p.sheetId, userId);
  if (locked.has(targetColumn)) {
    return { fail: 'locked', error: `Column "${targetColumn}" is being written by an active run. Stop it first.` };
  }
  if (p.sourceColumn && locked.has(p.sourceColumn)) {
    return {
      fail: 'locked',
      error: `Column "${p.sourceColumn}" is being written by an active run. Stop it first.`,
    };
  }

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
        const seedRows = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND user_id = ?')
          .all(p.sheetId, userId) as Array<{ id: string }>;
        for (const r of seedRows) {
          setCell.run(targetPath, '', r.id);
        }
        appendColumnsToOrder(p.sheetId, userId, [targetColumn]);
      }
      // Materialize (not .iterate()): better-sqlite3 forbids writing while a
      // cursor is open on the same connection, and we json_set per row below.
      // Only the rows passing `where` (SQLite checks it).
      const rows = db.prepare(`SELECT id, data FROM rows WHERE sheet_id = ? AND user_id = ? AND (${filter.sql})
        ORDER BY row_index ASC`).all(p.sheetId, userId, ...filter.params) as Array<{ id: string; data: string }>;
      let seen = 0;
      const written: string[] = [];
      for (const row of rows) {
        if ((++seen & 255) === 0 && Date.now() - startedAt > TRANSFORM_MAX_WRITER_MS) throw new WriterBudgetError();
        const data = parseRowData(row.data);
        const value = p.operation === 'template'
          ? applyTemplate(p.template!, data)
          : applyCellOp(p.operation, cellOf(data, p.sourceColumn!), { pattern: p.pattern, index: p.index });
        setCell.run(targetPath, value, row.id);
        written.push(row.id);
        updated++;
      }
      // A column another column's auto-run reads queues these rows for it.
      markAutorunInputs(p.sheetId, userId, [targetColumn], { ids: written });
      db.prepare(
        "UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      ).run(p.sheetId, userId);
    }).immediate();
  } catch (e) {
    if (e instanceof WriterBudgetError) {
      return {
        fail: 'budget',
        error: 'Transform exceeded its time budget. Narrow it with a where filter and retry.',
      };
    }
    throw e;
  }

  return { ok: { updated, created_column: targetExists ? null : targetColumn } };
}
