// Row mutation tools — same services/rows-write.ts flows as /api/v1 (stable
// row ids, update-only columns, run-locked errors, data_version bumps). With an
// idempotency_key, services/rows-write-keyed.ts (a retry replays the first
// answer): the sheet is checked after the ledger, so a retry replays even once
// the sheet is in the trash or busy (tool-helpers.ts lets a keyed update_cells
// through its busy gate).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import {
  API_V1_MAX_APPEND_ROWS, API_V1_MAX_BATCH_UPDATES, API_V1_MAX_DELETE_ROWS, API_V1_MAX_PATCH_CELLS,
  IDEMPOTENT_WRITE_KEY_MAX_CHARS,
} from '../lib/api-v1-constants';
import { parseCellMap, txnFailMessage } from '../services/data-plane-shared';
import { appendAnswer, appendRows, patchAnswer, patchRowById, deleteRowsByIds } from '../services/rows-write';
import { trashAnswer } from '../services/trash-answer';
import { batchUpdateRows } from '../services/rows-batch-update';
import { appendAutorunNotice } from '../services/enrich-agent-autorun';
import { appendRowsKeyed, batchUpdateKeyed, patchRowKeyed } from '../services/rows-write-keyed';
import { McpAuthCtx, ok, err, missingScope, registerTool, SHEET_ID } from './tool-helpers';

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const idempotencyKey = z.string().min(1).max(IDEMPOTENT_WRITE_KEY_MAX_CHARS).optional().describe(
  'Optional retry key: the same key with the same arguments within 24 hours returns the first answer '
  + '(replayed: true) and writes nothing; with other arguments it is refused.');
const RETRY_WORDS = 'idempotency_key makes a retry safe: the same key and arguments within 24 hours answer as '
  + 'the first call did, with replayed: true, and write nothing; the same key with other arguments is refused.';

export function registerRowTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'append_rows',
    {
      description:
        `Add up to ${API_V1_MAX_APPEND_ROWS} rows at the end of a sheet, each as {column: value}. For a file, use `
        + 'create_upload_link instead (the file never passes through your context); to copy rows from another '
        + 'sheet, transfer_rows. The columns must exist (add_column first). Returns the new rows\' ids and '
        + 'indexes, in the order given. With auto-dedupe on (set_auto_dedupe), a row whose key the sheet already '
        + 'had says kept: false (it went to the trash) and auto_dedupe says what was not kept or replaced. When '
        + 'auto-run is on, auto_run lists the columns that will fill the new rows on their own: an enrichment '
        + 'spends treg credit (estimated_usd), an HTTP API column sends real requests (sends_requests). Tell the '
        + `user. ${RETRY_WORDS} A replay leaves out auto_run (the first call set the runs off).`,
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        rows: z.array(z.record(z.string(), cellValue)).min(1).max(API_V1_MAX_APPEND_ROWS)
          .describe('Rows as {column: value}: text, a number or true/false; null leaves the cell empty'),
        idempotency_key: idempotencyKey,
      },
    },
    async ({ sheet_id, rows, idempotency_key }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!idempotency_key && !verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
      const parsedRows: Array<Record<string, string>> = [];
      for (const entry of rows) {
        const p = parseCellMap(entry, API_V1_MAX_PATCH_CELLS);
        if ('error' in p) return err(p.error);
        parsedRows.push(p.cells);
      }
      if (idempotency_key) {
        const keyed = appendRowsKeyed(sheet_id, ctx.userId, parsedRows, idempotency_key, 'mcp');
        if ('fail' in keyed) {
          return err(keyed.fail === 'sheet_not_found' ? 'Sheet not found' : txnFailMessage(keyed, MAX_ROWS_PER_SHEET));
        }
        if (keyed.replayed) return ok({ ...keyed.ok.answer, replayed: true });
        return ok({
          ...keyed.ok.answer, replayed: false, ...await appendAutorunNotice(ctx.userId, sheet_id, keyed.ok.kept),
        });
      }
      const result = appendRows(sheet_id, ctx.userId, parsedRows);
      if ('fail' in result) return err(txnFailMessage(result, MAX_ROWS_PER_SHEET));
      return ok({
        ...appendAnswer(ctx.userId, result.ok, 'mcp'),
        ...await appendAutorunNotice(ctx.userId, sheet_id, result.ok.kept),
      });
    },
  );

  registerTool(server, 
    'update_cells',
    {
      description:
        'Set cells on rows by their stable ids (read_rows gives them), in one of two forms. '
        + 'ONE ROW: {"row_id": "…", "data": {"Status": "Done"}} (sheet_id optional; when given, the row must be in '
        + 'it); returns the full row. '
        + 'MANY ROWS, all or nothing: {"sheet_id": "…", "updates": [{"row_id": "…", "data": {"Status": "Done"}}]} '
        + `(up to ${API_V1_MAX_BATCH_UPDATES}); returns {updated}. `
        + 'Columns must already exist (add_column first). Values: string/number/boolean; null clears a cell. '
        + 'Columns a run is still filling are refused. To fill a column from each row, use formula_column or '
        + `transform_column (free) rather than writing every cell. ${RETRY_WORDS}`,
      inputSchema: {
        row_id: z.string().optional().describe('One-row form: the row to update'),
        data: z.record(z.string(), cellValue).optional().describe('One-row form: {column: value}'),
        sheet_id: z.string().optional().describe('Required with updates; optional with row_id'),
        updates: z.array(z.object({
          row_id: z.string().describe('The row\'s id'),
          data: z.record(z.string(), cellValue).describe('{column: value}; null clears the cell'),
        })).min(1).max(API_V1_MAX_BATCH_UPDATES).optional()
          .describe(`Many-rows form: [{row_id, data}], up to ${API_V1_MAX_BATCH_UPDATES}`),
        idempotency_key: idempotencyKey,
      },
    },
    async ({ row_id, data, sheet_id, updates, idempotency_key }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
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
        const result = idempotency_key ? batchUpdateKeyed(sheet_id, ctx.userId, parsed, idempotency_key, 'mcp')
          : batchUpdateRows(sheet_id, ctx.userId, parsed, 'mcp');
        if ('fail' in result) {
          if (result.fail === 'duplicate_rows') return err('updates must not contain duplicate row ids');
          if (result.fail === 'sheet_not_found') return err('Sheet not found');
          return err(result.fail === 'not_found'
            ? 'One or more rows were not found in the supplied sheet.'
            : txnFailMessage(result, MAX_ROWS_PER_SHEET));
        }
        return ok({ ...result.ok, ...('replayed' in result ? { replayed: result.replayed === true } : {}) });
      }
      if (!row_id || data === undefined) return err('The one-row form needs both row_id and data.');
      if (idempotency_key) {
        // The row's sheet is checked after the key (a replay still answers once the row is gone).
        const p = parseCellMap(data, API_V1_MAX_PATCH_CELLS);
        if ('error' in p) return err(p.error);
        const keyed = patchRowKeyed(row_id, ctx.userId, p.cells, sheet_id, idempotency_key, 'mcp');
        if (!('fail' in keyed)) return ok({ ...keyed.ok, replayed: keyed.replayed });
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
      const result = patchRowById(row_id, ctx.userId, p.cells);
      if ('fail' in result) {
        return err(result.fail === 'not_found' ? 'Row not found' : txnFailMessage(result, MAX_ROWS_PER_SHEET));
      }
      return ok(patchAnswer(ctx.userId, result.ok, 'mcp'));
    },
  );

  registerTool(server, 
    'delete_rows',
    {
      description:
        `Delete up to ${API_V1_MAX_DELETE_ROWS} rows by their stable ids (read_rows with where and return_mode ids `
        + 'finds them; remove_duplicates removes duplicates). They go to the trash as one batch, kept for the days '
        + 'set in Settings (30 by default; 0 deletes at once): the answer gives its trash_id, and '
        + 'restore_from_trash puts them back. Refused while an AI or HTTP run is working on the sheet.',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        row_ids: z.array(z.string()).min(1).max(API_V1_MAX_DELETE_ROWS).describe('The rows\' ids'),
      },
    },
    async ({ sheet_id, row_ids }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
      const result = deleteRowsByIds(sheet_id, ctx.userId, row_ids);
      if ('fail' in result) return err(txnFailMessage(result, MAX_ROWS_PER_SHEET));
      return ok({
        deleted: result.ok.deleted,
        trash: result.ok.deleted ? trashAnswer(ctx.userId, result.ok.trashId, 'mcp') : null,
      });
    },
  );
}
