// /api/v1 routes: the account, tables, sheets and columns (api-v1.ts,
// api-v1-tables.ts, api-v1-table-sheets.ts, api-v1-sheets.ts, api-v1-sheet-ops.ts,
// api-v1-columns.ts).
import { z } from 'zod';
import { MAX_SHEET_NAME_LENGTH, MAX_TABLE_NAME_LENGTH } from '../lib/constants';
import { MAX_COLUMN_DESCRIPTION_CHARS, MAX_SHEET_DESCRIPTION_CHARS } from '../lib/constants-columns';
import { op, type RouteDoc } from './route-doc';
import { toolBody } from './tool-schemas';

const tableName = z.string().max(MAX_TABLE_NAME_LENGTH).describe('The table name.');
const sheetName = z.string().max(MAX_SHEET_NAME_LENGTH);
const describing = (max: number) => z.string().max(max).nullable()
  .describe('What it holds, for whoever reads it next. "" or null removes it.');

export const tableRoutes = (): RouteDoc[] => [
  op({
    method: 'get', path: '/me', operationId: 'getMe', tag: 'account', scope: 'read',
    summary: "Check a token: its name, scopes, and spend cap with what's left.",
  }),
  op({
    method: 'get', path: '/openapi.json', operationId: 'getOpenApiDocument', tag: 'account', scope: 'read',
    summary: 'This document: the OpenAPI description of /api/v1.',
    description: 'Any valid token can read it. Postman, Insomnia or Swagger UI can import it.',
  }),
  op({
    method: 'get', path: '/tables', operationId: 'listTables', tag: 'tables', scope: 'read',
    summary: 'List the tables with their sheets, ids and row counts.',
  }),
  op({
    method: 'post', path: '/tables', operationId: 'createTable', tag: 'tables', scope: 'write',
    summary: 'Make a table with one empty sheet.',
    body: z.object({ name: tableName }),
    responses: { 201: 'The new table and its first sheet.' },
  }),
  op({
    method: 'post', path: '/tables/sample', operationId: 'createSampleTable', tag: 'tables', scope: 'write',
    summary: 'Make a table of made-up leads, its free columns filled and its AI column set up but not run.',
    conflict: false,
    responses: { 201: 'The sample table, with its AI column and the first rows to try it on.' },
  }),
  op({
    method: 'patch', path: '/tables/{id}', operationId: 'renameTable', tag: 'tables', scope: 'write',
    summary: 'Rename a table.',
    body: z.object({ name: tableName }),
  }),
  op({
    method: 'delete', path: '/tables/{id}', operationId: 'deleteTable', tag: 'tables', scope: 'write',
    summary: 'Put a table, its sheets and their rows in the trash. Its runs stop first.',
  }),
  op({
    method: 'post', path: '/tables/{tableId}/sheets', operationId: 'createSheet', tag: 'tables', scope: 'write',
    summary: 'Add a sheet to a table.',
    body: z.object({
      name: sheetName.optional().describe('The sheet name. Left out, Cubex picks one.'),
      after_sheet_id: z.string().optional().describe('Put it right after this sheet. Default: at the end.'),
    }),
    responses: { 201: 'The new sheet and the table\'s sheets.' },
  }),
  op({
    method: 'patch', path: '/tables/{tableId}/sheets/order', operationId: 'reorderSheets', tag: 'tables',
    scope: 'write', summary: "Put a table's sheets in a new order.",
    body: z.object({ ordered_sheet_ids: z.array(z.string()).describe("Every sheet id of the table, in order.") }),
  }),
  op({
    method: 'patch', path: '/tables/{tableId}/sheets/{sheetId}', operationId: 'updateSheet', tag: 'tables',
    scope: 'write', summary: 'Rename a sheet, describe it, or both.',
    description: 'The description is checked first, so a bad one changes nothing.',
    body: z.object({
      name: sheetName.optional().describe('The new name. Required unless description is given.'),
      description: describing(MAX_SHEET_DESCRIPTION_CHARS).optional(),
    }),
  }),
  op({
    method: 'delete', path: '/tables/{tableId}/sheets/{sheetId}', operationId: 'deleteSheet', tag: 'tables',
    scope: 'write', summary: 'Put a sheet in the trash, whole. A table always keeps one sheet.',
  }),
  op({
    method: 'get', path: '/sheets/{id}', operationId: 'getSheet', tag: 'tables', scope: 'read',
    summary: "A sheet's columns, row count, versions, column details, views and what's running on it.",
    query: z.object({
      columns: z.array(z.string()).optional()
        .describe('Columns to show in full (prompts, formulas, URLs) and to count first. Repeat it for more.'),
      include_counts: z.enum(['true', 'false']).optional()
        .describe('true counts filled, empty and error rows per column. Reads every row: slower on big sheets.'),
    }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/sort', operationId: 'sortSheet', tag: 'tables', scope: 'write',
    summary: 'Sort the rows by a column, for good. The new order is saved.',
    body: toolBody('sort_sheet', { omit: ['sheet_id'] }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/copy', operationId: 'copySheet', tag: 'tables', scope: 'write',
    summary: "Copy a sheet's values to a new sheet right after it.",
    description: 'Plain columns that nothing fills, the same rows in the same order. Answers once every row is in.',
    body: z.object({
      name: sheetName.optional().describe('Default: "Copy of <sheet>".'),
      columns: z.array(z.string()).optional().describe('Only these columns. Default: all of them.'),
    }),
    responses: { 201: 'The new sheet, the sheets of the table, rows_copied and columns.' },
  }),
  op({
    method: 'get', path: '/sheets/{id}/export', operationId: 'exportSheetCsv', tag: 'tables', scope: 'read',
    summary: 'Download a sheet as CSV, streamed, any size.',
    query: z.object({
      view: z.string().optional().describe('A saved view, by name or id: export its rows and visible columns.'),
    }),
    produces: ['csv'], conflict: true,
    responses: { 200: 'The CSV. An empty sheet gives an empty body.' },
  }),
  op({
    method: 'post', path: '/sheets/{id}/columns', operationId: 'addColumn', tag: 'columns', scope: 'write',
    summary: 'Add an empty column.',
    body: z.object({
      name: z.string().describe('The column name. Names are unique in a sheet, whatever their case.'),
      description: describing(MAX_COLUMN_DESCRIPTION_CHARS).optional(),
    }),
    responses: { 201: 'The new column name, and its description when one was given.' },
  }),
  op({
    method: 'put', path: '/sheets/{id}/columns/order', operationId: 'reorderColumns', tag: 'columns',
    scope: 'write', summary: 'Put the columns in a new order.',
    body: z.object({ order: z.array(z.string()).describe('Every column of the sheet, once, in order.') }),
  }),
  op({
    method: 'patch', path: '/sheets/{id}/columns/{name}', operationId: 'updateColumn', tag: 'columns',
    scope: 'write', summary: 'Rename a column, describe it, or both.',
    description: 'A rename updates everything that names the column. The description is checked first.',
    body: z.object({
      name: z.string().optional().describe('The new name. Required unless description is given.'),
      description: describing(MAX_COLUMN_DESCRIPTION_CHARS).optional(),
    }),
  }),
  op({
    method: 'delete', path: '/sheets/{id}/columns/{name}', operationId: 'deleteColumn', tag: 'columns',
    scope: 'write', summary: 'Put a column in the trash with its cells, place, description and own setup.',
    description: 'What other columns, views and settings said about it is removed now; the restore lists each one. '
      + 'The answer\'s trash gives trash_id, kept_days, restorable_until and how_to_restore (trash_id null: '
      + 'Settings keeps deleted things 0 days, so it was deleted at once).',
  }),
];
