// Read tools: discovery + paged row reads. All delegate to the same
// services/workspace-read.ts the /api/v1 routes use.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../lib/db';
import { MCP_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import { MAX_ROWS_PER_SHEET, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { listTablesWithSheets, getSheetMeta, readRowsPage } from '../services/workspace-read';
import { queryRows, type WhereItem } from '../services/row-selection';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { INCLUDE_STATUS_HELP, whereSchema } from './where-schema';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);

export function registerReadTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'list_tables',
    {
      description:
        'List every table in the Cubex workspace with its sheets (tabs), their ids, names, and row counts. '
        + 'Start here to resolve a table/sheet name to a sheet_id.',
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
        + 'otherwise you discover the cap by having a write rejected. filling_columns lists columns still '
        + 'filling (add_enrichment_field, clean_column, formula_column): their cells read "⏳ Processing..." '
        + 'until done. clean_columns and formula_columns give each such column\'s setup and auto-run. '
        + 'active_runs lists the AI, HTTP and enrichment runs working on the sheet now (run_type, run_id, '
        + 'status, the column it fills, auto_run when an auto-run started it), and active_setup_runs the setups '
        + 'being used on it; control_run with action cancel_all stops them all.',
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
        'Read rows as {id, index, data} ordered by index. Keyset paging: pass cursor = the index of the last row '
        + 'from the previous page; next_cursor is null at the end. '
        + `Max ${MCP_MAX_ROWS_PAGE} rows per call. `
        + 'Pass columns to fetch only the fields you need — reading every column of a wide sheet is the main way '
        + 'these calls get expensive. '
        + 'PAGING A FILTERED READ: if you pass `where` AND a cursor, you must ALSO pass expected_data_version and '
        + 'expected_row_generation, '
        + 'echoing the values returned with the previous page (every response includes them). '
        + 'This is required only for filtered paging — an unfiltered read pages with just a cursor. '
        + 'The fence exists because filtered paging keysets on row index: if the sheet changes mid-page-walk, rows '
        + 'would be silently skipped or repeated, '
        + 'so you get a clean "restart paging" error instead of quietly wrong data. '
        + 'Row ids are STABLE across sorts — use them with update_cells and delete_rows. '
        + 'FILTERS: `where` (described on the field) finds rows by text, number, a list of values, OR groups, and run '
        + 'state: [{"operator":"has_error"}] returns the rows where any AI, HTTP API or enrichment run failed, and '
        + 'return_mode count says how many without reading them. include_status returns each run column\'s cell as '
        + '{status, value, error}, so you never parse ❌ / ⏭️ / ⏳ yourself.',
      inputSchema: {
        sheet_id: z.string(),
        cursor: z.number().int().min(0).optional().describe('index of the last row already received'),
        limit: z.number().int().min(1).max(MCP_MAX_ROWS_PAGE).optional(),
        columns: z.array(z.string()).min(1).optional()
          .describe('Only these columns. Omit for all (expensive on wide sheets).'),
        where: whereSchema.optional(),
        return_mode: z.enum(['rows', 'ids', 'count']).optional(),
        include_status: lenientBoolean().optional().describe(INCLUDE_STATUS_HELP),
        expected_data_version: z.number().int().min(0).optional()
          .describe('REQUIRED when paging a filtered read (where + cursor). Echo data_version from the previous page.'),
        expected_row_generation: z.number().int().min(0).optional()
          .describe('REQUIRED when paging a filtered read (where + cursor). '
            + 'Echo row_generation from the previous page.'),
      },
    },
    async ({
      sheet_id, cursor, limit, columns, where, return_mode, include_status, expected_data_version,
      expected_row_generation,
    }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      if (!columns && !where && !return_mode && expected_data_version === undefined
        && expected_row_generation === undefined) {
        const pageSize = Math.min(limit ?? MCP_MAX_ROWS_PAGE, MCP_MAX_ROWS_PAGE);
        return ok(readRowsPage(sheet_id, ctx.userId, cursor ?? -1, pageSize, include_status === true));
      }
      const result = await queryRows(sheet_id, ctx.userId, {
        after: cursor ?? -1,
        limit,
        columns,
        where: where as WhereItem[] | undefined,
        returnMode: return_mode ?? 'rows',
        includeStatus: include_status === true,
        expectedDataVersion: expected_data_version,
        expectedRowGeneration: expected_row_generation,
      });
      return 'fail' in result ? err(result.error) : ok(result.ok);
    },
  );
}
