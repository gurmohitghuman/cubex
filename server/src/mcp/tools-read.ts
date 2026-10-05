// Read tools: discovery + paged row reads. All delegate to the same
// services/workspace-read.ts the /api/v1 routes use.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../lib/db';
import { MCP_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import { MAX_ROWS_PER_SHEET, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { listTablesWithSheets, getSheetMeta, readRowsPage } from '../services/workspace-read';
import { queryRows } from '../services/row-selection';
import { McpAuthCtx, ok, err, missingScope, registerTool, rowConditionSchema as condition } from './tool-helpers';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);

export function registerReadTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'list_tables',
    {
      description:
        'List every table in the Cubex workspace with its sheets (tabs), their ids, names, and row counts. Start here to resolve a table/sheet name to a sheet_id.',
      inputSchema: {},
    },
    async () => missingScope(ctx, 'read') ?? ok({ tables: listTablesWithSheets(ctx.userId) }),
  );

  registerTool(server, 
    'get_sheet',
    {
      description:
        'Sheet metadata: ordered column names, row count, data_version, row_generation, and the '
        + 'remaining row/column budget (limits). Check limits before a large append or import — '
        + 'otherwise you discover the cap by having a write rejected.',
      inputSchema: { sheet_id: z.string() },
    },
    async ({ sheet_id }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const meta = getSheetMeta(sheet_id, ctx.userId);
      if (!meta) return err('Sheet not found');
      // Report REMAINING budget, not just the ceilings: "you can add 47 more
      // rows" needs no arithmetic, and the caps live in one place server-side
      // so an agent never has to hardcode them.
      return ok({
        ...meta,
        limits: {
          max_rows: MAX_ROWS_PER_SHEET,
          rows_remaining: Math.max(0, MAX_ROWS_PER_SHEET - meta.row_count),
          max_columns: MAX_COLUMNS_PER_SHEET,
          columns_remaining: Math.max(0, MAX_COLUMNS_PER_SHEET - meta.columns.length),
        },
      });
    },
  );

  registerTool(server, 
    'read_rows',
    {
      description:
        `Read rows as {id, index, data} ordered by index. Keyset paging: pass cursor = the index of the last row from the previous page; next_cursor is null at the end. Max ${MCP_MAX_ROWS_PAGE} rows per call. `
        + 'Pass columns to fetch only the fields you need — reading every column of a wide sheet is the main way these calls get expensive. '
        + 'PAGING A FILTERED READ: if you pass `where` AND a cursor, you must ALSO pass expected_data_version and expected_row_generation, '
        + 'echoing the values returned with the previous page (every response includes them). '
        + 'This is required only for filtered paging — an unfiltered read pages with just a cursor. '
        + 'The fence exists because filtered paging keysets on row index: if the sheet changes mid-page-walk, rows would be silently skipped or repeated, '
        + 'so you get a clean "restart paging" error instead of quietly wrong data. '
        + 'Row ids are STABLE across sorts — use them with update_cells and delete_rows.',
      inputSchema: {
        sheet_id: z.string(),
        cursor: z.number().int().min(0).optional().describe('index of the last row already received'),
        limit: z.number().int().min(1).max(MCP_MAX_ROWS_PAGE).optional(),
        columns: z.array(z.string()).min(1).optional()
          .describe('Only these columns. Omit for all (expensive on wide sheets).'),
        where: z.array(condition).min(1).optional(),
        return_mode: z.enum(['rows', 'ids', 'count']).optional(),
        expected_data_version: z.number().int().min(0).optional()
          .describe('REQUIRED when paging a filtered read (where + cursor). Echo data_version from the previous page.'),
        expected_row_generation: z.number().int().min(0).optional()
          .describe('REQUIRED when paging a filtered read (where + cursor). Echo row_generation from the previous page.'),
      },
    },
    async ({ sheet_id, cursor, limit, columns, where, return_mode, expected_data_version, expected_row_generation }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      if (!columns && !where && !return_mode && expected_data_version === undefined && expected_row_generation === undefined) {
        return ok(readRowsPage(sheet_id, ctx.userId, cursor ?? -1, Math.min(limit ?? MCP_MAX_ROWS_PAGE, MCP_MAX_ROWS_PAGE)));
      }
      const result = queryRows(sheet_id, ctx.userId, {
        after: cursor ?? -1,
        limit,
        columns,
        where,
        returnMode: return_mode ?? 'rows',
        expectedDataVersion: expected_data_version,
        expectedRowGeneration: expected_row_generation,
      });
      return 'fail' in result ? err(result.error) : ok(result.ok);
    },
  );
}
