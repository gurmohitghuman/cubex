// /api/v1 routes: reading and writing rows, CSV import, row transfers,
// duplicates and saved views (api-v1-sheets.ts, api-v1-rows.ts, api-v1-import.ts,
// api-v1-transfer.ts, api-v1-sheet-ops.ts, api-v1-views.ts).
import { z } from 'zod';
import {
  API_V1_MAX_APPEND_ROWS, API_V1_MAX_BATCH_UPDATES, API_V1_MAX_DELETE_ROWS, API_V1_MAX_PATCH_CELLS,
  API_V1_MAX_ROWS_PAGE, API_V1_DEFAULT_ROWS_PAGE, IDEMPOTENT_WRITE_KEY_MAX_CHARS, IDEMPOTENT_WRITE_KEYS_MAX,
  IDEMPOTENT_WRITE_ROW_BYTES,
} from '../lib/api-v1-constants';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { MAX_VIEW_DESCRIPTION_CHARS, MAX_VIEW_NAME_CHARS } from '../lib/constants-filters';
import { CELL_CUT_MAX_CHARS, CELL_CUT_MIN_CHARS } from '../lib/constants-query';
import { DIGITS_TEXT } from '../lib/digits-text';
import { whereSchema } from '../mcp/where-schema';
import { MAX_CHARS_PER_CELL_HELP } from '../mcp/query-schema';
import { op, type RouteDoc } from './route-doc';
import { toolBody } from './tool-schemas';

const cells = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe(`{column: value}, up to ${API_V1_MAX_PATCH_CELLS} columns. Columns must exist; null clears a cell.`);
// A row write's retry key (api-v1-rows.ts, services/rows-write-keyed.ts).
const retryKey = z.string().min(1).max(IDEMPOTENT_WRITE_KEY_MAX_CHARS);
const retryHeaders = z.object({
  'Idempotency-Key': retryKey.optional().describe('Or idempotency_key in the body. The same key and arguments '
    + 'within 24 hours answer as the first call did (replayed: true) and write nothing; other arguments get 409. '
    + `An account keeps its newest ${IDEMPOTENT_WRITE_KEYS_MAX.toLocaleString('en-US')} row-write keys, so past `
    + 'that an older key is forgotten sooner.'),
});
const retryBody = { idempotency_key: retryKey.optional().describe('Or the Idempotency-Key header.') };
const replay = 'A retry with the same idempotency key and arguments answers as the first call did, with '
  + 'replayed: true.';
const rowsPage = z.object({
  limit: z.number().int().min(1).max(API_V1_MAX_ROWS_PAGE).optional()
    .describe(`Rows per page, 1 to ${API_V1_MAX_ROWS_PAGE}. Default ${API_V1_DEFAULT_ROWS_PAGE}.`),
  cursor: z.number().int().min(0).optional().describe('next_cursor from the previous page.'),
});
// A view's where: a list of conditions, or null or [] for none.
const viewWhere = z.union([whereSchema, z.array(z.unknown()).max(0), z.null()]);
const hiddenColumns = z.array(z.string()).nullable().describe('Columns the view hides. null or [] shows them all.');
const viewDescription = z.string().max(MAX_VIEW_DESCRIPTION_CHARS).nullable();

export const rowRoutes = (): RouteDoc[] => [
  op({
    method: 'get', path: '/sheets/{id}/rows', operationId: 'listRows', tag: 'rows', scope: 'read',
    summary: 'Read rows as {id, index, data}, a page at a time.',
    query: rowsPage.extend({
      include_status: z.enum(['true', 'false']).optional()
        .describe("true: each run column's cell comes back as {status, value, error}."),
    }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/rows/query', operationId: 'queryRows', tag: 'rows', scope: 'read',
    summary: 'Find rows with filters, pick columns, count them, or sum them up by group.',
    body: toolBody('read_rows', {
      omit: ['sheet_id', 'limit', 'include_status', 'max_chars_per_cell'],
      extend: {
        limit: rowsPage.shape.limit,
        include_status: z.boolean().optional().describe("true: run columns' cells as {status, value, error}."),
        max_chars_per_cell: z.union([z.number().int().min(CELL_CUT_MIN_CHARS).max(CELL_CUT_MAX_CHARS),
          z.string().regex(DIGITS_TEXT)]).optional()
          .describe(`${MAX_CHARS_PER_CELL_HELP} Digits sent as text ("200") count as the number.`),
      },
    }),
    responses: { 200: 'The rows, ids, count or groups asked for. With max_chars_per_cell, cut_cells lists the '
      + 'cells cut: {"<row id>": {"<column>": <full length>}}, {} when none.' },
    conflict: true,
  }),
  op({
    method: 'post', path: '/sheets/{id}/rows', operationId: 'appendRows', tag: 'rows', scope: 'write',
    summary: 'Add rows at the end of a sheet.',
    description: "Note the data wrapper (MCP's append_rows takes the objects directly).",
    headers: retryHeaders,
    body: z.object({
      rows: z.array(z.object({ data: cells })).min(1).max(API_V1_MAX_APPEND_ROWS)
        .describe(`Up to ${API_V1_MAX_APPEND_ROWS} rows.`),
      ...retryBody,
    }),
    responses: {
      201: 'The new stable row ids, in order, and the auto-runs that will fill them.',
      200: `${replay} Nothing is added, and auto_run is left out.`,
    },
  }),
  op({
    method: 'patch', path: '/rows/{rowId}', operationId: 'updateRow', tag: 'rows', scope: 'write',
    summary: 'Set cells on one row.',
    headers: retryHeaders,
    body: z.object({ data: cells, ...retryBody }),
    responses: {
      200: `The row: its id, index and cells. ${replay} A replay leaves out cells over `
        + `${IDEMPOTENT_WRITE_ROW_BYTES / 1024} KB (data_left_out: true): read the row to see them.`,
    },
  }),
  op({
    method: 'post', path: '/sheets/{id}/rows/update', operationId: 'updateRows', tag: 'rows', scope: 'write',
    summary: 'Set cells on many rows at once, all or nothing.',
    body: z.object({
      updates: z.array(z.object({ row_id: z.string(), data: cells })).min(1).max(API_V1_MAX_BATCH_UPDATES)
        .describe(`Up to ${API_V1_MAX_BATCH_UPDATES} rows, each once.`),
      ...retryBody,
    }),
    headers: retryHeaders,
    responses: { 200: `How many rows changed. ${replay}` },
  }),
  op({
    method: 'post', path: '/sheets/{id}/rows/delete', operationId: 'deleteRows', tag: 'rows', scope: 'write',
    summary: 'Put rows in the trash, by their stable ids.',
    body: z.object({ row_ids: z.array(z.string()).min(1).max(API_V1_MAX_DELETE_ROWS) }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/import', operationId: 'importCsv', tag: 'rows', scope: 'write',
    summary: 'Import a CSV file into a sheet: add its rows, or replace the rows.',
    form: z.object({
      file: z.file().mime('text/csv')
        .describe(`The .csv file, up to ${Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024))} MB.`),
      replace: z.enum(['true', 'false']).optional()
        .describe('true replaces the rows (the old ones go to the trash). Default: add them.'),
    }),
    responses: { 201: 'How many rows came in, the new columns, and what was left out.' },
  }),
  op({
    method: 'post', path: '/sheets/{sourceId}/rows/transfer', operationId: 'transferRows', tag: 'rows',
    scope: 'write', summary: 'Copy or move rows to another sheet.',
    description: 'Only there when the server runs with MCP_EFFICIENT_ROWS_ENABLED=1.',
    flag: 'MCP_EFFICIENT_ROWS_ENABLED',
    headers: z.object({
      'Idempotency-Key': z.string().describe('Required. A retry with the same key replays the first answer.'),
    }),
    body: toolBody('transfer_rows', {
      pick: ['destination_sheet_id', 'operation', 'selection', 'columns', 'column_mode', 'column_mapping'],
    }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/remove-duplicates', operationId: 'removeDuplicates', tag: 'rows',
    scope: 'read', scopeNote: 'Removing (dry_run false) needs write.',
    summary: 'Find duplicate rows, and remove them when dry_run is false.',
    body: toolBody('remove_duplicates', { omit: ['sheet_id'], strict: true }),
  }),
  op({
    method: 'put', path: '/sheets/{id}/auto-dedupe', operationId: 'setAutoDedupe', tag: 'rows', scope: 'write',
    summary: 'Keep one row per key as rows arrive. Fields left out keep what the setting has.',
    body: toolBody('set_auto_dedupe', { pick: ['column', 'match', 'phone_country', 'keep'], strict: true }),
  }),
  op({
    method: 'delete', path: '/sheets/{id}/auto-dedupe', operationId: 'turnOffAutoDedupe', tag: 'rows',
    scope: 'write', summary: 'Turn auto-dedupe off.',
  }),
  op({
    method: 'get', path: '/sheets/{id}/views', operationId: 'listViews', tag: 'views', scope: 'read',
    summary: "List a sheet's saved views, Default first.",
  }),
  op({
    method: 'post', path: '/sheets/{id}/views', operationId: 'createView', tag: 'views', scope: 'write',
    summary: 'Save a view: a copy of the view showing (or of from), then the filters and hidden columns given.',
    description: "It doesn't switch the view the app shows.",
    body: z.object({
      name: z.string().max(MAX_VIEW_NAME_CHARS),
      description: viewDescription.optional(),
      from: z.string().optional().describe('The view to copy, by name or id. Default: the one the app shows.'),
      where: viewWhere.optional(),
      hidden_columns: hiddenColumns.optional(),
    }),
    responses: { 201: 'The new view.' },
  }),
  op({
    method: 'patch', path: '/sheets/{id}/views/{viewId}', operationId: 'updateView', tag: 'views', scope: 'write',
    summary: "Change a view's name, description, filters or hidden columns.",
    description: 'where and hidden_columns replace what the view had.',
    body: z.object({
      name: z.string().max(MAX_VIEW_NAME_CHARS).optional(),
      description: viewDescription.optional(),
      where: viewWhere.optional(),
      hidden_columns: hiddenColumns.optional(),
    }),
  }),
  op({
    method: 'delete', path: '/sheets/{id}/views/{viewId}', operationId: 'deleteView', tag: 'views',
    scope: 'write', summary: 'Delete a view, never rows or columns. The Default view stays.',
  }),
];
