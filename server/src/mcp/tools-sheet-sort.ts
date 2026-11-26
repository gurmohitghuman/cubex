// manage_sheet's sort and describe (tools-structure.ts): sort reorders a sheet's rows by one column permanently
// (services/sheet-sort.ts, as POST /v1/sheets/:id/sort), describe sets the sheet's own description
// (services/descriptions.ts). Neither needs table_id. SORT_FIELDS is sort's input, which REST's sort body reads.
import { z } from 'zod';
import { db } from '../lib/db';
import { physicalSortSheet } from '../services/sheet-sort';
import { describeSheet } from '../services/descriptions';
import { verifySheetInTable } from '../lib/sheet-crud-helpers';
import { McpAuthCtx, ok, err, type ErrResult, type OkResult } from './tool-helpers';
import { changedOf } from './changed';
import type { ToolAnswer } from './tool-outputs';

export const SORT_FIELDS = {
  column: z.string().describe('The column to sort by'),
  direction: z.enum(['asc', 'desc']).describe('asc: A to Z, smallest first; desc: the other way'),
};
export const SORT_ACTIONS = ['sort', 'describe'] as const;
export type SortAction = typeof SORT_ACTIONS[number];
export const SORT_WORDS = 'sort reorders the rows by column, permanently: there is no live sort (read_rows with where '
  + 'or a saved view reads another order or a subset); row ids stay, indexes change. describe sets the sheet\'s '
  + 'own description ("" clears it; a column\'s: manage_column).';

interface Args { table_id?: string; sheet_id?: string; column?: string; direction?: 'asc' | 'desc';
  description?: string }

export async function runSortAction(ctx: McpAuthCtx, action: SortAction, a: Args):
  Promise<OkResult<ToolAnswer<'manage_sheet'>> | ErrResult> {
  if (!a.sheet_id) return err(`sheet_id is required for ${action}`);
  const sheetId = a.sheet_id;
  const owned = a.table_id !== undefined ? verifySheetInTable(sheetId, a.table_id, ctx.userId)
    : !!db.prepare('SELECT 1 FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(sheetId, ctx.userId);
  if (!owned) return err('Sheet not found');
  if (action === 'describe') {
    if (a.column !== undefined || a.direction !== undefined) return err('column and direction are for sort.');
    if (a.description === undefined) return err('describe needs description ("" clears it).');
    const outcome = describeSheet(sheetId, ctx.userId, a.description);
    if ('fail' in outcome) return err(outcome.message);
    return ok({ description: outcome.ok.description, changed: changedOf(ctx.userId, [{ sheetId, columns: [] }]) });
  }
  if (a.description !== undefined) return err('description is for describe.');
  if (!a.column || !a.direction) return err('sort needs column and direction.');
  const result = await physicalSortSheet(sheetId, ctx.userId, a.column, a.direction, { bumpDataVersion: true });
  if ('fail' in result) {
    if (result.fail === 'busy') return err(result.error);
    return err(result.fail === 'column_not_found' ? `Column "${a.column}" not found in this sheet` : result.message);
  }
  return ok({
    rows_reordered: result.rowsReordered,
    changed: changedOf(ctx.userId, [{ sheetId, rows: result.rowsReordered }]),
  });
}
