// Row mutation tools — same services/rows-write.ts flows as /api/v1 (stable
// row ids, update-only columns, run-locked errors, data_version bumps).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../lib/db';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { API_V1_MAX_APPEND_ROWS, API_V1_MAX_BATCH_UPDATES, API_V1_MAX_DELETE_ROWS, API_V1_MAX_PATCH_CELLS } from '../lib/api-v1-constants';
import { parseCellMap, txnFailMessage } from '../services/data-plane-shared';
import { appendRows, patchRowById, deleteRowsByIds } from '../services/rows-write';
import { batchUpdateRows } from '../services/rows-batch-update';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);

export function registerRowTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'append_rows',
    {
      description:
        `Append rows to the end of a sheet. Each row is a {columnName: value} object; every column must already exist (use add_column first). Values: string/number/boolean; null clears. Max ${API_V1_MAX_APPEND_ROWS} rows per call. Returns the created stable row ids.`,
      inputSchema: {
        sheet_id: z.string(),
        rows: z.array(z.record(z.string(), cellValue)).min(1).max(API_V1_MAX_APPEND_ROWS),
      },
    },
    async ({ sheet_id, rows }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const parsedRows: Array<Record<string, string>> = [];
      for (const entry of rows) {
        const p = parseCellMap(entry, API_V1_MAX_PATCH_CELLS);
        if ('error' in p) return err(p.error);
        parsedRows.push(p.cells);
      }
      const result = appendRows(sheet_id, ctx.userId, parsedRows);
      if ('fail' in result) return err(txnFailMessage(result, MAX_ROWS_PER_SHEET));
      return ok(result.ok);
    },
  );

  registerTool(server, 
    'update_cells',
    {
      description:
        'Set cells on rows addressed by stable row id, in one of two forms. '
        + 'ONE ROW: {"row_id": "…", "data": {"Status": "Done"}} (sheet_id optional; when given, the row must be in it); returns the full row. '
        + `MANY ROWS, all or nothing: {"sheet_id": "…", "updates": [{"row_id": "…", "data": {"Status": "Done"}}]} (up to ${API_V1_MAX_BATCH_UPDATES}); returns {updated}. `
        + 'Columns must already exist (add_column first). Values: string/number/boolean; null clears a cell. '
        + 'Columns a run is still filling are refused.',
      inputSchema: {
        row_id: z.string().optional().describe('One-row form: the row to update'),
        data: z.record(z.string(), cellValue).optional().describe('One-row form: {column: value}'),
        sheet_id: z.string().optional().describe('Required with updates; optional with row_id'),
        updates: z.array(z.object({
          row_id: z.string(), data: z.record(z.string(), cellValue),
        })).min(1).max(API_V1_MAX_BATCH_UPDATES).optional().describe('Many-rows form: [{row_id, data}]'),
      },
    },
    async ({ row_id, data, sheet_id, updates }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const single = row_id !== undefined || data !== undefined;
      const batch = updates !== undefined;
      if (single === batch) {
        return err('Use one form: {row_id, data} for one row, or {sheet_id, updates: [{row_id, data}]} for many.');
      }
      if (batch) {
        if (!sheet_id) return err('The many-rows form needs sheet_id with updates.');
        if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
        const parsed = [];
        for (const update of updates) {
          const p = parseCellMap(update.data, API_V1_MAX_PATCH_CELLS);
          if ('error' in p) return err(p.error);
          parsed.push({ rowId: update.row_id, cells: p.cells });
        }
        const result = batchUpdateRows(sheet_id, ctx.userId, parsed);
        if ('fail' in result) {
          if (result.fail === 'duplicate_rows') return err('updates must not contain duplicate row ids');
          return err(result.fail === 'not_found' ? 'One or more rows were not found in the supplied sheet.' : txnFailMessage(result, MAX_ROWS_PER_SHEET));
        }
        return ok(result.ok);
      }
      if (!row_id || data === undefined) return err('The one-row form needs both row_id and data.');
      if (sheet_id !== undefined
        && !db.prepare('SELECT 1 FROM rows WHERE id = ? AND sheet_id = ? AND user_id = ?').get(row_id, sheet_id, ctx.userId)) {
        return err('Row not found in that sheet');
      }
      const p = parseCellMap(data, API_V1_MAX_PATCH_CELLS);
      if ('error' in p) return err(p.error);
      const result = patchRowById(row_id, ctx.userId, p.cells);
      if ('fail' in result) {
        return err(result.fail === 'not_found' ? 'Row not found' : txnFailMessage(result, MAX_ROWS_PER_SHEET));
      }
      return ok(result.ok);
    },
  );

  registerTool(server, 
    'delete_rows',
    {
      description:
        `PERMANENTLY delete rows by their stable row ids (there is no undo). Fails while any AI/HTTP run is active on the sheet. Max ${API_V1_MAX_DELETE_ROWS} ids per call.`,
      inputSchema: {
        sheet_id: z.string(),
        row_ids: z.array(z.string()).min(1).max(API_V1_MAX_DELETE_ROWS),
      },
    },
    async ({ sheet_id, row_ids }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const result = deleteRowsByIds(sheet_id, ctx.userId, row_ids);
      if ('fail' in result) return err(txnFailMessage(result, MAX_ROWS_PER_SHEET));
      return ok(result.ok);
    },
  );
}
