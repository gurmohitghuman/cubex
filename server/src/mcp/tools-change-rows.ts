// change_rows: update (set cells) or delete rows by their stable ids, on the same services/rows-write.ts flows
// as /api/v1 (update-only columns, run-locked errors, data_version bumps). An update with an idempotency_key
// goes through services/rows-write-keyed.ts (a retry replays the first answer): the sheet is checked after the
// ledger, so a retry replays even once the sheet is in the trash or busy (tool-helpers.ts lets a keyed
// change_rows through its busy gate; a delete takes no key). Deleted rows go to the trash as one batch.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { API_V1_MAX_BATCH_UPDATES, API_V1_MAX_DELETE_ROWS, API_V1_MAX_PATCH_CELLS } from '../lib/api-v1-constants';
import { parseCellMap, txnFailMessage } from '../services/data-plane-shared';
import { patchAnswer, patchRowById, deleteRowsByIds } from '../services/rows-write';
import { trashAnswer } from '../services/trash-answer';
import { batchUpdateRows } from '../services/rows-batch-update';
import { batchUpdateKeyed, patchRowKeyed } from '../services/rows-write-keyed';
import { McpAuthCtx, ok, err, missingScope, registerTool, type ErrResult, type OkResult } from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';
import { changedOf, columnsOf, editedTouch } from './changed';
import { GUIDE_POINTER } from './guides/guide';
import { cellValue, idempotencyKey } from './tools-rows';

type Cells = Record<string, string | number | boolean | null>;
interface UpdateArgs {
  row_id?: string; data?: Cells; sheet_id?: string; updates?: Array<{ row_id: string; data: Cells }>;
  idempotency_key?: string;
}

export function registerChangeRows(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server,
    'change_rows',
    {
      description:
        'Update or delete rows by their stable ids (read_rows gives them). update sets cells, in one of two forms. '
        + 'ONE ROW: {"row_id": "…", "data": {"Status": "Done"}} (sheet_id optional; when given, the row must be in '
        + 'it); returns the full row. '
        + 'MANY ROWS, all or nothing: {"sheet_id": "…", "updates": [{"row_id": "…", "data": {"Status": "Done"}}]} '
        + `(up to ${API_V1_MAX_BATCH_UPDATES}); returns {updated}. `
        + 'Columns must already exist (manage_column add first). Values: string/number/boolean; null clears a cell. '
        + 'Columns a run is still filling are refused. To fill a column from each row, use formula_column or '
        + 'transform_column (free) rather than writing every cell. '
        + `delete: up to ${API_V1_MAX_DELETE_ROWS} rows of sheet_id by row_ids, to the trash (restore_from_trash `
        + `puts them back). ${GUIDE_POINTER}`,
      inputSchema: {
        action: z.enum(['update', 'delete']).describe('What to do'),
        sheet_id: z.string().optional().describe('Required with updates and for delete; optional with row_id'),
        row_id: z.string().optional().describe('update, one-row form: the row to update'),
        data: z.record(z.string(), cellValue).optional().describe('update, one-row form: {column: value}'),
        updates: z.array(z.object({
          row_id: z.string().describe('The row\'s id'),
          data: z.record(z.string(), cellValue).describe('{column: value}; null clears the cell'),
        })).min(1).max(API_V1_MAX_BATCH_UPDATES).optional()
          .describe(`update, many-rows form: [{row_id, data}], up to ${API_V1_MAX_BATCH_UPDATES}`),
        idempotency_key: idempotencyKey,
        row_ids: z.array(z.string()).min(1).max(API_V1_MAX_DELETE_ROWS).optional()
          .describe('delete: the rows\' ids'),
      },
    },
    async ({ action, row_ids, ...update }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (action === 'update') {
        if (row_ids !== undefined) return err('row_ids is for delete; update takes row_id and data, or updates.');
        return updateRows(ctx, update);
      }
      const { sheet_id, ...updateOnly } = update;
      if (Object.values(updateOnly).some(v => v !== undefined)) {
        return err('row_id, data, updates and idempotency_key are for update; delete takes sheet_id and row_ids.');
      }
      if (!sheet_id || !row_ids) return err('delete needs sheet_id and row_ids.');
      if (!verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
      const result = deleteRowsByIds(sheet_id, ctx.userId, row_ids);
      if ('fail' in result) return err(txnFailMessage(result, MAX_ROWS_PER_SHEET));
      const { deleted } = result.ok;
      return ok({
        deleted, trash: deleted ? trashAnswer(ctx.userId, result.ok.trashId, 'mcp') : null,
        // Every id named was deleted when the counts agree: then they are the rows.
        changed: deleted ? changedOf(ctx.userId, [{ sheetId: sheet_id, rows: deleted,
          ...(deleted === new Set(row_ids).size ? { rowIds: [...new Set<string>(row_ids)] } : {}) }]) : [],
      });
    },
  );
}

async function updateRows(ctx: McpAuthCtx, a: UpdateArgs): Promise<OkResult<ToolAnswer<'change_rows'>> | ErrResult> {
  const { row_id, data, sheet_id, updates, idempotency_key } = a;
  const single = row_id !== undefined || data !== undefined;
  const batch = updates !== undefined;
  if (single === batch) {
    return err('Use one form: {row_id, data} for one row, or {sheet_id, updates: [{row_id, data}]} for many.');
  }
  if (batch) {
    if (!sheet_id) return err('The many-rows form needs sheet_id with updates.');
    if (!idempotency_key && !verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
    const parsed = [];
    for (const update of updates) {
      const p = parseCellMap(update.data, API_V1_MAX_PATCH_CELLS);
      if ('error' in p) return err(p.error);
      parsed.push({ rowId: update.row_id, cells: p.cells });
    }
    const keyed = idempotency_key ? batchUpdateKeyed(sheet_id, ctx.userId, parsed, idempotency_key, 'mcp') : null;
    const result = keyed ?? batchUpdateRows(sheet_id, ctx.userId, parsed, 'mcp');
    if ('fail' in result) {
      if (result.fail === 'duplicate_rows') return err('updates must not contain duplicate row ids');
      if (result.fail === 'sheet_not_found') return err('Sheet not found');
      return err(result.fail === 'not_found'
        ? 'One or more rows were not found in the supplied sheet.'
        : txnFailMessage(result, MAX_ROWS_PER_SHEET));
    }
    // A keyed call's changed comes with it (stored with the key, for a replay).
    if (keyed && !('fail' in keyed)) return ok({ ...keyed.ok, replayed: keyed.replayed, changed: keyed.changed });
    return ok({ ...result.ok, changed: changedOf(ctx.userId, [editedTouch(sheet_id,
      columnsOf(parsed.map(u => u.cells)), parsed.map(u => u.rowId), result.ok.auto_dedupe)]) });
  }
  if (!row_id || data === undefined) return err('The one-row form needs both row_id and data.');
  if (idempotency_key) {
    // The row's sheet is checked after the key (a replay still answers once the row is gone).
    const p = parseCellMap(data, API_V1_MAX_PATCH_CELLS);
    if ('error' in p) return err(p.error);
    const keyed = patchRowKeyed(row_id, ctx.userId, p.cells, sheet_id, idempotency_key, 'mcp');
    if (!('fail' in keyed)) return ok({ ...keyed.ok, replayed: keyed.replayed, changed: keyed.changed });
    return err(keyed.fail === 'not_in_sheet' ? 'Row not found in that sheet'
      : keyed.fail === 'not_found' ? 'Row not found' : txnFailMessage(keyed, MAX_ROWS_PER_SHEET));
  }
  if (sheet_id !== undefined
    && !db.prepare('SELECT 1 FROM rows WHERE id = ? AND sheet_id = ? AND user_id = ?')
      .get(row_id, sheet_id, ctx.userId)) {
    return err('Row not found in that sheet');
  }
  const p = parseCellMap(data, API_V1_MAX_PATCH_CELLS);
  if ('error' in p) return err(p.error);
  // The row's sheet, for changed: read first, as auto-dedupe may send the row to the trash.
  const rowSheet = sheet_id ?? db.prepare('SELECT sheet_id FROM rows WHERE id = ? AND user_id = ?')
    .pluck().get(row_id, ctx.userId) as string | undefined;
  const result = patchRowById(row_id, ctx.userId, p.cells);
  if ('fail' in result) {
    return err(result.fail === 'not_found' ? 'Row not found' : txnFailMessage(result, MAX_ROWS_PER_SHEET));
  }
  const answer = patchAnswer(ctx.userId, result.ok, 'mcp');
  return ok({ ...answer, changed: changedOf(ctx.userId,
    [rowSheet ? editedTouch(rowSheet, Object.keys(p.cells), [row_id], answer.auto_dedupe) : null]) });
}
