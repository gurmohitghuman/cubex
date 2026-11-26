// append_rows: the same services/rows-write.ts flow as /api/v1 (stable row ids, data_version bumps). With an
// idempotency_key, services/rows-write-keyed.ts (a retry replays the first answer). change_rows updates and
// deletes rows (tools-change-rows.ts).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import {
  API_V1_MAX_APPEND_ROWS, API_V1_MAX_PATCH_CELLS, IDEMPOTENT_WRITE_KEY_MAX_CHARS,
} from '../lib/api-v1-constants';
import { parseCellMap, txnFailMessage } from '../services/data-plane-shared';
import { appendAnswer, appendRows } from '../services/rows-write';
import { appendAutorunNotice } from '../services/enrich-agent-autorun';
import { appendChanged, appendRowsKeyed } from '../services/rows-write-keyed';
import { McpAuthCtx, ok, err, missingScope, registerTool, SHEET_ID } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';

export const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const idempotencyKey = z.string().min(1).max(IDEMPOTENT_WRITE_KEY_MAX_CHARS).optional().describe(
  'Optional retry key: the same key with the same arguments within 24 hours returns the first answer '
  + '(replayed: true) and writes nothing; with other arguments it is refused.');

export function registerRowTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'append_rows',
    {
      description:
        `Add up to ${API_V1_MAX_APPEND_ROWS} rows at the end of a sheet, each as {column: value}. For a file, use `
        + 'create_upload_link instead (the file never passes through your context); to copy rows from another '
        + 'sheet, transfer_rows. The columns must exist (manage_column add first). Returns the new rows\' ids and '
        + 'indexes, in the order given. With auto-dedupe on (set_auto_dedupe), a row whose key the sheet already '
        + 'had says kept: false (it went to the trash) and auto_dedupe says what was not kept or replaced. When '
        + 'auto-run is on, auto_run lists the columns that will fill the new rows on their own: an enrichment '
        + 'spends treg credit (estimated_usd), an HTTP API column sends real requests (sends_requests). Tell the '
        + `user. ${GUIDE_POINTER}`,
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
        if (keyed.replayed) return ok({ ...keyed.ok.answer, replayed: true, changed: keyed.changed });
        return ok({
          ...keyed.ok.answer, replayed: false, changed: keyed.changed,
          ...await appendAutorunNotice(ctx.userId, sheet_id, keyed.ok.kept),
        });
      }
      const result = appendRows(sheet_id, ctx.userId, parsedRows);
      if ('fail' in result) return err(txnFailMessage(result, MAX_ROWS_PER_SHEET));
      const changed = appendChanged(ctx.userId, sheet_id, parsedRows, result.ok);
      return ok({
        ...appendAnswer(ctx.userId, result.ok, 'mcp'), changed,
        ...await appendAutorunNotice(ctx.userId, sheet_id, result.ok.kept),
      });
    },
  );
}
