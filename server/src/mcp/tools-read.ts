// Read tools: discovery + paged row reads. All delegate to the same
// services/workspace-read.ts the /api/v1 routes use.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { db } from '../lib/db';
import { MCP_MAX_ROWS_PAGE, MCP_ROWS_BY_ID_MAX_CHARS, ROWS_BY_ID_MAX } from '../lib/api-v1-constants';
import { MAX_ROWS_PER_SHEET, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { listTablesWithSheets, readRowsPage } from '../services/workspace-read';
import { readSheetDetails } from '../services/sheet-details';
import { COLUMN_COUNTS_MAX_COLUMNS } from '../lib/constants-columns';
import { queryRows, type WhereItem } from '../services/row-selection';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, SHEET_ID } from './tool-helpers';
import { INCLUDE_STATUS_HELP, VIEW_HELP, whereSchema } from './where-schema';
import { aggregatesSchema, columnsSchema, fitGroups, groupBySchema, maxCharsPerCellSchema } from './query-schema';
import { parseColumns } from '../lib/row-select/paths';
import { parseAggregate } from '../lib/row-aggregate/spec';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(sheetId, userId);

export function registerReadTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'list_tables',
    {
      description:
        'List every table in the workspace with its sheets (tabs): ids, names, positions and row counts (each '
        + 'counted in full, so slower on big sheets). get_workspace is the first look; use this to turn a table '
        + 'or sheet name it left out into a sheet_id, then get_sheet for its columns or read_rows for its rows.',
      inputSchema: {},
    },
    async () => missingScope(ctx, 'read') ?? ok({ tables: listTablesWithSheets(ctx.userId) }),
  );

  registerTool(server, 
    'get_sheet',
    {
      description:
        'A sheet\'s structure and state. Read it before choosing what to run or fix, then read_rows or a run '
        + 'tool. Answers the columns in order, row_count, data_version, row_generation, its description and '
        + 'limits (rows and columns left: check before a big append or import). column_details says for each '
        + 'column its kind (plain, ai, http, enrichment, waterfall, webhook, clean, formula, lookup), what fills it '
        + '(fill: its newest run or its setup; filled_by names the column whose run fills it), the columns it '
        + 'reads, auto_run, run_if (the "Only run if" rule) and description. Prompts, formulas and URLs are cut '
        + 'short unless the column is named in columns; credentials in a URL read "…". include_counts adds filled, '
        + `errors (a failed run or ❌) and empty (the rest: not run, skipped, running) per column, reading every `
        + `row (up to ${COLUMN_COUNTS_MAX_COLUMNS} columns: those in `
        + 'columns, else the first). Also: filling_columns (their cells read "⏳ Processing..." until done), the '
        + 'setups of clean, formula and lookup columns (a lookup\'s broken says why it stopped, and kept_changing '
        + 'why rows it looked up may hold older values), active_runs and '
        + 'active_setup_runs (control_run cancel_all stops them all), views (pass view to read_rows or '
        + 'export_csv) and auto_dedupe (set_auto_dedupe\'s setting, or null).',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        columns: z.array(z.string()).optional()
          .describe('Columns to show in full (prompts, formulas, URLs) and to count first'),
        include_counts: lenientBoolean().optional()
          .describe('Count filled, empty and error rows per column (reads every row; slower on big sheets). '
            + 'Default false'),
      },
    },
    async ({ sheet_id, columns, include_counts }, mcp) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      // Counting stops on a cancel or a hang-up (an initialize-era client's hang-up aborts only ctx.abortSignal).
      const read = await readSheetDetails(sheet_id, ctx.userId, { columns, counts: include_counts === true,
        stop: () => mcp.mcpReq.signal.aborted || ctx.abortSignal?.aborted === true });
      if (!read) return err('Sheet not found');
      if ('error' in read) return err(read.error);
      const meta = read.ok;
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
        'Read a sheet\'s rows as {id, index, data}, in index order, up to ' + `${MCP_MAX_ROWS_PAGE} a call. `
        + 'Pass columns: reading every column of a wide sheet is what makes reads expensive. Row ids stay the '
        + 'same across sorts: use them with update_cells and delete_rows. '
        + 'PAGES: cursor = the last row\'s index; next_cursor is null at the end. A filtered read (where) that '
        + 'pages also echoes expected_data_version and expected_row_generation from the page before, so a sheet '
        + 'that changed answers "restart paging" instead of skipping or repeating rows. '
        + 'FILTER with where: text, numbers, dates, lists of values, OR groups and run state '
        + '([{"operator":"has_error"}]: rows where any run failed). return_mode count or ids answers without '
        + 'cells. include_status reads each run column\'s cell as {status, value, error}, so you never parse '
        + '❌ ⏭️ ⏳ yourself. '
        + 'SUM UP without reading rows: group_by and aggregates count, sum and average per value (top values of '
        + 'a column: group_by:["Industry"]). '
        + `BY ID: row_ids (1 to ${ROWS_BY_ID_MAX}) returns those rows in that order with updated_at, and missing `
        + '(ids that are no row here; list_trash has deleted ones). About 40,000 characters a call: read '
        + 'unread_ids next. Prefer it to re-read rows you know, such as those a run just touched. With '
        + 'include_status a failed cell\'s error is its run\'s full message when Cubex finds it. Takes columns, '
        + 'include_status and max_chars_per_cell only. '
        + 'CHANGED SINCE: updated_since returns rows whose cells changed at or after that UTC second, oldest '
        + 'change first, with updated_at; page with cursor = next_cursor (text). To keep a copy up to date: when '
        + 'next_cursor is null, pass as_of as the next updated_since and dedupe by id. Deleted rows don\'t show '
        + '(list ids with return_mode ids now and then); a sort is no change; filling lists columns still being '
        + 'filled. Takes columns, include_status, limit and cursor. '
        + 'LONG CELLS: max_chars_per_cell cuts each cell and lists the cut ones in cut_cells; read those whole '
        + 'with row_ids and columns.',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        // Digits sent as text are the number cursor (a model often quotes it).
        cursor: z.preprocess(v => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v.trim()) : v),
          z.union([z.number().int().min(0), z.string().min(1)])).optional()
          .describe('index of the last row already received, or the next_cursor (text) of an updated_since read'),
        limit: z.number().int().min(1).max(MCP_MAX_ROWS_PAGE).optional()
          .describe(`Rows a call, 1 to ${MCP_MAX_ROWS_PAGE} (the default)`),
        columns: columnsSchema.optional(),
        where: whereSchema.optional(),
        return_mode: z.enum(['rows', 'ids', 'count']).optional()
          .describe('rows (default); ids: each row\'s id and index only; count: how many rows pass'),
        include_status: lenientBoolean().optional().describe(INCLUDE_STATUS_HELP),
        expected_data_version: z.number().int().min(0).optional()
          .describe('REQUIRED when paging a filtered read (where + cursor). Echo data_version from the previous page.'),
        expected_row_generation: z.number().int().min(0).optional()
          .describe('REQUIRED when paging a filtered read (where + cursor). '
            + 'Echo row_generation from the previous page.'),
        group_by: groupBySchema.optional(),
        aggregates: aggregatesSchema.optional(),
        view: z.string().min(1).optional().describe(VIEW_HELP),
        expected_view_version: z.string().optional()
          .describe('REQUIRED when paging through a view (view + cursor). Echo view_version from the previous page.'),
        row_ids: z.array(z.string()).min(1).max(ROWS_BY_ID_MAX).optional()
          .describe(`Read exactly these rows by their stable ids, in this order (1 to ${ROWS_BY_ID_MAX})`),
        updated_since: z.string().optional()
          .describe('Rows whose cells changed at or after this UTC time (2026-11-05T10:00:00Z or 2026-11-05 10:00:00)'),
        max_chars_per_cell: maxCharsPerCellSchema.optional(),
      },
    },
    async ({
      sheet_id, cursor, limit, columns, where, return_mode, include_status, expected_data_version,
      expected_row_generation, view, expected_view_version, group_by, aggregates, row_ids, updated_since,
      max_chars_per_cell,
    }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const after = typeof cursor === 'number' ? cursor : -1;
      const byIdOrTime = row_ids !== undefined || updated_since !== undefined || typeof cursor === 'string';
      if (!columns && !where && !view && !return_mode && !group_by && !aggregates && !byIdOrTime
        && expected_data_version === undefined && expected_row_generation === undefined
        && max_chars_per_cell === undefined) {
        const pageSize = Math.min(limit ?? MCP_MAX_ROWS_PAGE, MCP_MAX_ROWS_PAGE);
        return ok(readRowsPage(sheet_id, ctx.userId, after, pageSize, include_status === true));
      }
      const picked = columns ? parseColumns(columns) : undefined;
      if (picked && 'error' in picked) return err(picked.error);
      const aggregate = parseAggregate(group_by, aggregates);
      if ('error' in aggregate) return err(aggregate.error);
      const result = await queryRows(sheet_id, ctx.userId, {
        after,
        ...(typeof cursor === 'string' ? { sinceCursor: cursor } : {}),
        ...(row_ids !== undefined ? { rowIds: row_ids, maxChars: MCP_ROWS_BY_ID_MAX_CHARS } : {}),
        ...(updated_since !== undefined ? { updatedSince: updated_since } : {}),
        limit,
        columns: picked?.names,
        ...(picked?.picks ? { picks: picked.picks } : {}),
        ...(aggregate.spec ? { aggregate: aggregate.spec } : {}),
        where: where as WhereItem[] | undefined,
        returnMode: return_mode ?? 'rows',
        includeStatus: include_status === true,
        expectedDataVersion: expected_data_version,
        expectedRowGeneration: expected_row_generation,
        view,
        expectedViewVersion: expected_view_version,
        ...(max_chars_per_cell !== undefined ? { maxCharsPerCell: max_chars_per_cell } : {}),
      });
      if ('fail' in result) return err(result.error);
      return ok(aggregate.spec ? fitGroups(result.ok) : result.ok);
    },
  );
}
