// Workspace conveniences that closed real gaps found while dogfooding:
//   export_csv — the only way out of a sheet was read_rows, which drags every
//                cell through the model's context. Same objection that justifies
//                transfer_rows over read-then-append.
//   list_runs  — runs were fetchable only BY ID, so after a failed or
//                interrupted start the run id was gone with no way back to it.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../lib/db';
import { buildSheetCsv } from '../lib/csv-export';
import { listRuns, RUN_LIST_MAX, RUN_LIST_DEFAULT } from '../services/run-list';
import { MCP_EXPORT_MAX_CHARS } from '../lib/api-v1-constants';
import { McpAuthCtx, ok, err, missingScope, registerTool, rowConditionSchema as condition } from './tool-helpers';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);

export function registerWorkspaceTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server,
    'export_csv',
    {
      description:
        'Export sheet rows as CSV text, optionally narrowed with columns and where. '
        + 'COST WARNING: the CSV comes back as a STRING IN YOUR CONTEXT, so exporting a wide or long '
        + 'sheet is EXPENSIVE — always pass columns and where to fetch only what you need. '
        + `At most ${MCP_EXPORT_MAX_CHARS.toLocaleString('en-US')} characters come back: past that the result says `
        + 'truncated: true (with the total row count when there is no where); get the rest with read_rows (same columns/where, paged), '
        + 'or save it all as a file of any size with create_download_link. '
        + 'Use this when you want CSV specifically (to hand to another tool, or save verbatim); '
        + 'for reading data to reason over, read_rows with the same columns/where is usually cheaper '
        + 'and pages. Values are escaped against spreadsheet formula injection.',
      inputSchema: {
        sheet_id: z.string(),
        columns: z.array(z.string()).min(1).optional()
          .describe('Only these columns, in this order. Omit for every column (expensive on wide sheets).'),
        where: z.array(condition).min(1).optional()
          .describe('Only rows matching ALL conditions — same filter shape as read_rows.'),
      },
    },
    async ({ sheet_id, columns, where }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const result = await buildSheetCsv(sheet_id, ctx.userId, { columns, where, maxChars: MCP_EXPORT_MAX_CHARS });
      if ('fail' in result) {
        // 'empty' is data ("nothing there yet"), not a failure — an agent
        // scripting over sheets shouldn't have to special-case a new sheet.
        // Matches the /api/v1 export route's empty-200 behavior.
        if (result.fail === 'empty') return ok({ sheet_id, sheet_name: null, csv: '', row_count: 0 });
        if (result.fail === 'invalid' || result.fail === 'busy') return err(result.error);
        return err('Sheet not found');
      }
      if (result.truncated) {
        return ok({
          sheet_id, sheet_name: result.sheetName, csv: result.csv, columns: result.columns,
          row_count: result.rowCount, matching_rows: result.matchingRows, truncated: true,
          rest: `Only the first ${result.rowCount} of ${result.matchingRows ?? 'the'} matching rows fit. `
            + 'Page through the rest with read_rows (same columns/where), or save everything as a file '
            + 'with create_download_link.',
        });
      }
      // rowCount comes from the builder (matched rows), NOT from counting lines:
      // a cell containing a newline is quoted but still splits on '\n', which
      // made the old line-count wrong on exactly the data most likely to have it.
      return ok({
        sheet_id,
        sheet_name: result.sheetName,
        csv: result.csv,
        row_count: result.rowCount,
        columns: result.columns,
      });
    },
  );

  registerTool(server,
    'list_runs',
    {
      description:
        'List recent AI and HTTP runs, newest first — use this to FIND a run_id you no longer have '
        + '(after a failed start, a disconnect, or a run someone else kicked off), then pass it to '
        + "get_run_status, get_run_results, or control_run. filter 'active' shows only runs still "
        + "pending/running/paused; 'terminal' shows finished ones. Omit sheet_id for the whole workspace.",
      inputSchema: {
        sheet_id: z.string().optional().describe('Limit to one sheet; omit for every sheet'),
        filter: z.enum(['active', 'terminal', 'all']).optional().describe("Default 'all'"),
        limit: z.number().int().min(1).max(RUN_LIST_MAX).optional()
          .describe(`Max runs to return, default ${RUN_LIST_DEFAULT}, max ${RUN_LIST_MAX}`),
      },
    },
    async ({ sheet_id, filter, limit }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      // Validate sheet ownership explicitly: without it an unknown/foreign
      // sheet_id would silently return [] and read as "no runs here" rather
      // than "that isn't your sheet".
      if (sheet_id !== undefined && !ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const runs = listRuns(ctx.userId, { sheetId: sheet_id, filter, limit });
      return ok({ runs, count: runs.length });
    },
  );
}
