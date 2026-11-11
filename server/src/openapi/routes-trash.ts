// /api/v1 routes: what runs cost, the trash, and a sheet's history
// (api-v1-usage.ts, api-v1-trash.ts).
import { z } from 'zod';
import { USAGE_DEFAULT_ROWS, USAGE_MAX_ROWS } from '../lib/constants-usage';
import {
  CHANGE_LOG_PAGE_MAX, TRASH_IDS_MAX, TRASH_LIST_PAGE, TRASH_RESTORE_PICK_MAX, TRASH_ROWS_PAGE_MAX,
} from '../lib/constants-trash';
import { USAGE_GROUPS } from '../lib/usage-query';
import { TRASH_HOWS } from '../lib/trash/store';
import { op, type RouteDoc } from './route-doc';

const day = z.string().describe('A day such as 2026-10-01 (UTC).');
const trashId = z.number().int().min(1);

export const trashRoutes = (): RouteDoc[] => [
  op({
    method: 'get', path: '/usage', operationId: 'getUsage', tag: 'runs', scope: 'read',
    summary: 'What runs cost, by column, day or run, for one sheet or the whole account.',
    description: 'Days are UTC, and a run counts on the day it started. Totals always cover the whole range.',
    query: z.object({
      sheet_id: z.string().optional().describe('Leave out for the whole account.'),
      group_by: z.enum(USAGE_GROUPS).optional().describe('Default column.'),
      range: z.enum(['this_week', 'this_month', 'last_week', 'last_month']).optional()
        .describe('Default this_month. Or give from and to instead.'),
      from: day.optional(),
      to: day.optional(),
      limit: z.number().int().min(1).max(USAGE_MAX_ROWS).optional().describe(`Rows. Default ${USAGE_DEFAULT_ROWS}.`),
      format: z.enum(['json', 'csv']).optional().describe('csv downloads every row. Default json.'),
    }),
    produces: ['json', 'csv'], notFound: true,
  }),
  op({
    method: 'get', path: '/trash', operationId: 'listTrash', tag: 'trash', scope: 'read',
    summary: "What's in the trash: deleted rows, sheets, tables and columns, newest first.",
    query: z.object({
      q: z.string().optional().describe('A table, sheet, column or token name.'),
      kind: z.enum(['rows', 'sheet', 'table', 'column']).optional(),
      how: z.enum(TRASH_HOWS as [string, ...string[]]).optional().describe('How it was deleted.'),
      sheet_id: z.string().optional(),
      before: trashId.optional().describe('next_before from the previous page.'),
      limit: z.number().int().min(1).max(TRASH_LIST_PAGE).optional(),
    }),
  }),
  op({
    method: 'get', path: '/trash/{id}', operationId: 'getTrashItem', tag: 'trash', scope: 'read',
    summary: 'One item in the trash.',
  }),
  op({
    method: 'get', path: '/trash/{id}/rows', operationId: 'listTrashRows', tag: 'trash', scope: 'read',
    summary: 'The rows of a batch in the trash (or the cells of a column, one row each), a page at a time.',
    query: z.object({
      after: z.number().int().min(0).optional().describe('next_after from the previous page.'),
      limit: z.number().int().min(1).max(TRASH_ROWS_PAGE_MAX).optional(),
      column: z.string().optional().describe('Search this column only.'),
      contains: z.string().optional().describe('Only rows holding this text.'),
    }),
  }),
  op({
    method: 'get', path: '/trash/{id}/csv', operationId: 'downloadTrashRows', tag: 'trash', scope: 'read',
    summary: 'The rows of a batch in the trash (or the cells of a column), as CSV.',
    produces: ['csv'],
  }),
  op({
    method: 'post', path: '/trash/restore', operationId: 'restoreFromTrash', tag: 'trash', scope: 'write',
    summary: 'Put items back from the trash: tables, then sheets, then columns and rows, newest deletion first.',
    description: 'A column comes back with its cells, place, description and own setup, under "<name> (restored)" '
      + 'when its name was taken; references_dropped lists what other columns, views and settings said about it '
      + 'that did not come back, with how to set each up again.',
    body: z.object({ trash_ids: z.array(trashId).min(1).max(TRASH_IDS_MAX) }),
    responses: { 200: 'results: what each item did, restored or why not.' }, conflict: false,
  }),
  op({
    method: 'post', path: '/trash/{id}/restore', operationId: 'restoreTrashItem', tag: 'trash', scope: 'write',
    summary: 'Put one item back from the trash, or only some rows of a batch.',
    description: 'A column comes back whole (no seqs), with its cells, place, description and own setup; its '
      + 'answer has name, renamed, cells_restored, cells_skipped, cells_kept, setup and references_dropped.',
    responses: { 200: 'Restored, or state "restoring" for a big one going on in the background.',
      403: "A column whose request reads saved API keys, from a token without the 'secrets' scope." },
    body: z.object({
      seqs: z.array(z.number().int()).min(1).max(TRASH_RESTORE_PICK_MAX).optional()
        .describe('Rows picked from a batch, by seq. Left out: the whole item.'),
    }),
  }),
  op({
    method: 'get', path: '/sheets/{id}/history', operationId: 'getSheetHistory', tag: 'trash', scope: 'read',
    summary: 'What changed on a sheet and who did it, newest first.',
    query: z.object({
      before: z.number().int().min(1).optional().describe('next_before from the previous page (a change id).'),
      limit: z.number().int().min(1).max(CHANGE_LOG_PAGE_MAX).optional(),
      column: z.string().optional().describe('Only changes to this column.'),
    }),
  }),
];
