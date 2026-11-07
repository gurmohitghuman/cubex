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
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
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
        'Sheet metadata: ordered column names, row count, data_version, row_generation, the sheet\'s '
        + 'description, and the remaining row/column budget (limits). Check limits before a large append or '
        + 'import: otherwise you discover the cap by having a write rejected. '
        + 'column_details says, for every column in order, its kind (plain, ai, http, enrichment, waterfall, '
        + 'webhook, clean, formula, lookup), what fills it (fill: its newest run with run_id and run_status, or its '
        + 'setup; a column another column\'s run fills names that column in filled_by and its role), the columns '
        + 'it reads, auto_run, run_if (the "Only run if" rule its next run checks) and its description. Prompts, '
        + 'formulas and URLs are cut short unless you name the column in columns; credentials in a URL read "…". '
        + 'include_counts adds each column\'s counts: filled (a value), errors (a failed run or ❌) and empty '
        + `(the rest: not run, skipped, running), counting every row: up to ${COLUMN_COUNTS_MAX_COLUMNS} columns, `
        + 'the ones in columns or else the first. Read it before choosing what to run or fix. '
        + 'filling_columns lists columns still '
        + 'filling (add_enrichment_field, clean_column, formula_column, lookup_column): their cells read '
        + '"⏳ Processing..." until done. clean_columns, formula_columns and lookup_columns give each such '
        + 'column\'s setup and auto-run (a lookup column\'s broken says why it stopped, and kept_changing why '
        + 'rows it looked up may hold older values). '
        + 'active_runs lists the AI, HTTP and enrichment runs working on the sheet now (run_type, run_id, '
        + 'status, the column it fills, auto_run when an auto-run started it), and active_setup_runs the setups '
        + 'being used on it; control_run with action cancel_all stops them all. views lists the saved views (name, '
        + 'description, filters as a where, hidden_columns; active is the one the app shows): pass view to '
        + 'read_rows or export_csv to read through one. auto_dedupe is the sheet\'s set_auto_dedupe setting '
        + '(column, match, keep, state, removed_rows so far, shared_rows already sharing a key when it was turned '
        + 'on, waiting_rows still to check), or null.',
      inputSchema: {
        sheet_id: z.string(),
        columns: z.array(z.string()).optional()
          .describe('Columns to show in full (prompts, formulas, URLs) and to count first'),
        include_counts: lenientBoolean().optional()
          .describe('Count filled, empty and error rows per column (reads every row; slower on big sheets)'),
      },
    },
    async ({ sheet_id, columns, include_counts }, extra) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      // Counting stops when the client cancels or goes away.
      const read = await readSheetDetails(sheet_id, ctx.userId,
        { columns, counts: include_counts === true, stop: () => extra.signal.aborted });
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
        'Read rows as {id, index, data} ordered by index. Keyset paging: pass cursor = the index of the last row '
        + 'from the previous page; next_cursor is null at the end. ' + `Max ${MCP_MAX_ROWS_PAGE} rows per call. `
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
        + '{status, value, error}, so you never parse ❌ / ⏭️ / ⏳ yourself. '
        + 'PROFILE OR SUM UP without reading rows: group_by and aggregates answer counts, sums and averages per '
        + 'value (top values of a column: group_by:["Industry"]). columns can take one value out of a JSON cell. '
        + `BY ID: row_ids (1 to ${ROWS_BY_ID_MAX}) returns exactly those rows in the order given, each with its `
        + 'updated_at, and missing: the ids that are no row of this sheet (deleted ones included: list_trash). '
        + 'Prefer it to re-read rows you know, such as the rows a run just touched. With include_status a failed '
        + 'cell\'s error is the full message its run recorded when Cubex finds it within its budget (on a '
        + 'column with thousands of runs it often doesn\'t), otherwise the cell\'s own words. It takes columns and '
        + 'include_status only. Rows stop at about 40,000 characters: ask again with unread_ids. '
        + 'CHANGED SINCE: updated_since (UTC, 2026-11-05T10:00:00Z) returns the rows whose cells changed at or after '
        + 'that second, oldest change first, each with its updated_at, cells as stored; page with limit and cursor = '
        + 'next_cursor (text). filling lists columns being filled again (their changed rows come in a later read). '
        + 'Prefer it to keep a copy up to date: when next_cursor is null, pass as_of as the next updated_since and '
        + 'dedupe by id (a row can come back). Deleted rows don\'t show: now and then list ids with return_mode '
        + 'ids and drop the rows gone. A sort is no change. It takes columns, include_status, limit and cursor. '
        + 'LONG CELLS: max_chars_per_cell (e.g. 200) cuts each cell\'s text to that many characters and lists the '
        + 'cells cut in cut_cells {"<row id>": {"<column>": full length}}: page or scan long AI answers or JSON '
        + 'without filling your context, then read the cells you need whole with row_ids + columns. Any read of '
        + 'rows takes it. A cut never leaves half of a surrogate pair; an emoji of several characters can lose parts.',
      inputSchema: {
        sheet_id: z.string(),
        // Digits sent as text are the number cursor (a model often quotes it).
        cursor: z.preprocess(v => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v.trim()) : v),
          z.union([z.number().int().min(0), z.string().min(1)])).optional()
          .describe('index of the last row already received, or the next_cursor (text) of an updated_since read'),
        limit: z.number().int().min(1).max(MCP_MAX_ROWS_PAGE).optional(),
        columns: columnsSchema.optional(),
        where: whereSchema.optional(),
        return_mode: z.enum(['rows', 'ids', 'count']).optional(),
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
          .describe('Read exactly these rows by their stable ids, in this order'),
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
