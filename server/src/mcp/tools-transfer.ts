import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { transferRows, TransferRequest } from '../services/rows-transfer';
import { TransferSelection } from '../services/transfer-selection';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, rowConditionSchema as condition } from './tool-helpers';


export function registerTransferTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'transfer_rows', {
    description:
      'Atomically copy or move rows between two sheets entirely server-side (no cell data returns to you). ' +
      'Missing destination columns are created by default (column_mode create_missing) and reported in created_columns; ' +
      'columns limits the transfer to a subset of source columns. A stable idempotency_key is required: ' +
      'retrying with the same key returns the original result instead of duplicating rows.',
    inputSchema: {
      source_sheet_id: z.string(),
      destination_sheet_id: z.string(),
      operation: z.enum(['copy', 'move']),
      selection: z.object({
        all: lenientBoolean().optional(),
        row_ids: z.array(z.string()).min(1).max(MAX_ROWS_PER_SHEET).optional(),
        where: z.array(condition).min(1).optional(),
      }),
      columns: z.array(z.string()).min(1).optional(),
      column_mode: z.enum(['require_existing', 'create_missing']).optional(),
      column_mapping: z.record(z.string(), z.string()).optional(),
      idempotency_key: z.string().min(1).max(200),
    },
  }, async input => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const choices = [input.selection.all === true, !!input.selection.row_ids, !!input.selection.where].filter(Boolean).length;
    if (choices !== 1) return err('selection must contain exactly one of all:true, row_ids, or where.');
    const selection: TransferSelection = input.selection.all === true ? { all: true }
      : input.selection.row_ids ? { row_ids: input.selection.row_ids }
      : { where: input.selection.where! };
    const request: TransferRequest = {
      sourceSheetId: input.source_sheet_id,
      destinationSheetId: input.destination_sheet_id,
      operation: input.operation,
      selection,
      columns: input.columns,
      columnMode: input.column_mode ?? 'create_missing',
      columnModeOmitted: input.column_mode === undefined,
      columnMapping: input.column_mapping ?? {},
      idempotencyKey: input.idempotency_key,
    };
    const result = transferRows(ctx.userId, request);
    return 'fail' in result ? err(result.error) : ok({ ...result.ok, replayed: result.replayed ?? false });
  });
}
