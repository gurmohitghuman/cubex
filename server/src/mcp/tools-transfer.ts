import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { TRANSFER_MAX_ROWS } from '../lib/api-v1-constants';
import { transferRows, TransferRequest } from '../services/rows-transfer';
import { trashAnswer } from '../services/trash-answer';
import { TransferSelection } from '../services/transfer-selection';
import { appendAutorunNotice } from '../services/enrich-agent-autorun';
import {
  McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean,
} from './tool-helpers';
import { whereLike } from './where-schema';

export function registerTransferTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'transfer_rows', {
    description:
      'Copy or move rows from one sheet to another, all or nothing, on the server: no cell data comes back to '
      + 'you, so use it rather than read_rows then append_rows. Pick the rows with selection (all, row_ids or a '
      + 'where). A move takes the source rows to the trash as one batch (trash says how to get them back). '
      + 'Missing destination columns are made by default (column_mode create_missing) and listed in created_columns. '
      + `At most ${TRANSFER_MAX_ROWS.toLocaleString('en-US')} rows a call. When auto-run is on in the destination, `
      + 'auto_run lists the columns that will fill the new rows (an enrichment spends treg credit, an HTTP API '
      + 'column sends real requests). Returns copied, moved and the columns made. Next: read_rows on the '
      + 'destination.',
    inputSchema: {
      source_sheet_id: z.string().describe('The sheet the rows come from'),
      destination_sheet_id: z.string().describe('The sheet they go to'),
      operation: z.enum(['copy', 'move']).describe('copy keeps the source rows; move takes them to the trash'),
      selection: z.object({
        all: lenientBoolean().optional().describe('true: every row'),
        row_ids: z.array(z.string()).min(1).max(MAX_ROWS_PER_SHEET).optional()
          .describe('Stable row ids (read_rows), no duplicates'),
        where: whereLike('The rows it passes.').optional(),
      }).describe('Exactly one of all:true, row_ids or where'),
      columns: z.array(z.string()).min(1).optional().describe('Only these source columns (default: all)'),
      column_mode: z.enum(['require_existing', 'create_missing']).optional()
        .describe('create_missing (default) makes destination columns it lacks; require_existing refuses instead'),
      column_mapping: z.record(z.string(), z.string()).optional()
        .describe('Source column -> destination column, where the names differ'),
      idempotency_key: z.string().min(1).max(200)
        .describe('Required, 1-200 characters: a retry with the same key returns the first result, no duplicates'),
    },
  }, async input => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const choices = [input.selection.all === true, !!input.selection.row_ids, !!input.selection.where]
      .filter(Boolean).length;
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
    const result = transferRows(ctx.userId, request, 'mcp');
    if ('fail' in result) return err(result.error);
    const notice = result.replayed ? {}
      : await appendAutorunNotice(ctx.userId, input.destination_sheet_id,
        result.ok.copied + result.ok.moved - (result.ok.auto_dedupe?.not_kept_count ?? 0));
    const trash = result.ok.moved ? { trash: trashAnswer(ctx.userId, result.ok.trash_id ?? null, 'mcp') } : {};
    return ok({ ...result.ok, replayed: result.replayed ?? false, ...notice, ...trash });
  });
}
