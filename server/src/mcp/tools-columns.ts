// Column, sort and column order tools: the shared cascade services (column-add/-rename/
// -delete, sheet-sort), identical invariants to /api/v1 and the UI.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { db } from '../lib/db';
import { addSheetColumn } from '../services/column-add';
import { renameSheetColumn } from '../services/column-rename';
import { deleteSheetColumn } from '../services/column-delete';
import { trashAnswer } from '../services/trash-answer';
import { physicalSortSheet } from '../services/sheet-sort';
import { describeColumn, describeSheet, descriptionProblem } from '../services/descriptions';
import { reorderSheetColumns } from '../services/column-reorder';
import { MAX_COLUMN_DESCRIPTION_CHARS, MAX_SHEET_DESCRIPTION_CHARS } from '../lib/constants-columns';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { McpAuthCtx, ok, err, missingScope, registerTool, SHEET_ID } from './tool-helpers';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(sheetId, userId);

export function registerColumnTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'add_column',
    {
      description:
        'Add an empty column at the end, to write into with append_rows or update_cells. To fill a column from '
        + 'each row instead, use formula_column, clean_column, lookup_column (free) or run_ai_column, '
        + 'run_enrichment, waterfall_column (paid): each makes its own column. A name that differs from an '
        + 'existing one only in case or spacing is refused. Returns the name.',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID), name: z.string().describe('The new column\'s name'),
        description: z.string().optional().describe('What the column holds, for people and agents'),
      },
    },
    async ({ sheet_id, name, description }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const problem = descriptionProblem(description, 'column');
      if (problem) return err(problem);
      const result = addSheetColumn(sheet_id, ctx.userId, name, { bumpDataVersion: true, seedEmptyRow: false });
      if ('fail' in result) return err(result.error);
      if (description === undefined) return ok({ name: result.name });
      const described = describeColumn(sheet_id, ctx.userId, result.name, description);
      return ok({ name: result.name, ...('ok' in described ? described.ok : {}) });
    },
  );

  registerTool(server,
    'set_description',
    {
      description:
        'Describe a column, or the sheet itself when column is left out: what it holds, where its values come '
        + 'from, how to read it. People see it in the app (on the column header, on the sheet\'s tab) and agents '
        + 'in get_sheet (description and column_details). It is never sent to AI runs. An empty description '
        + `clears it. Up to ${MAX_COLUMN_DESCRIPTION_CHARS.toLocaleString('en-US')} characters for a column, `
        + `${MAX_SHEET_DESCRIPTION_CHARS.toLocaleString('en-US')} for a sheet. Renaming a column keeps its `
        + 'description; deleting it deletes the description too.',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        column: z.string().optional().describe('The column to describe; leave out to describe the sheet'),
        description: z.string().describe('The words; "" clears it'),
      },
    },
    async ({ sheet_id, column, description }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const outcome = column === undefined
        ? describeSheet(sheet_id, ctx.userId, description)
        : describeColumn(sheet_id, ctx.userId, column, description);
      if ('fail' in outcome) return err(outcome.message);
      return ok({ ...(column === undefined ? {} : { column }), description: outcome.ok.description });
    },
  );

  registerTool(server, 
    'rename_column',
    {
      description:
        'Rename a column. Everything that names it follows: cells, order, filters, views, webhook mappings and '
        + 'the /references in saved AI prompts and HTTP requests. Refused while a run writes or reads the column '
        + '(stop it with control_run first). Returns the new name.',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID), column: z.string().describe('Its name now'),
        new_name: z.string().describe('Its new name'),
      },
    },
    async ({ sheet_id, column, new_name }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const result = await renameSheetColumn(sheet_id, ctx.userId, column, new_name, { bumpDataVersion: true });
      if ('fail' in result) {
        return err(result.fail === 'column_not_found' ? `Column "${column}" not found in this sheet` : result.error);
      }
      return ok({ name: result.newName });
    },
  );

  registerTool(server, 
    'delete_column',
    {
      description:
        'Delete a column: it goes to the trash with its cells, its place, its description and its own setup '
        + '(what makes it an AI, HTTP API, enrichment, waterfall, formula, lookup or clean column), and the '
        + 'answer\'s trash says until when and how to restore it (restore_from_trash). What other columns, views '
        + 'and settings said about it is removed now and does not come back with it: its own auto-run, filters '
        + 'and hidden columns in views, webhook mappings, fields another run writes into it, lookups in other '
        + 'sheets reading it, auto-dedupe on it; the restore answer lists each one so you can set it up again. '
        + 'With Settings keeping deleted things 0 days it is deleted at once (trash_id null). A big column\'s '
        + 'cells take a while: past a few seconds the answer\'s trash says state "moving" (they go on in the '
        + 'background, and a restore waits until they are all in). Refused for '
        + 'run-owned columns, columns an active run reads, webhook marker columns, and the last remaining column.',
      inputSchema: { sheet_id: z.string().describe(SHEET_ID), column: z.string().describe('The column\'s name') },
    },
    async ({ sheet_id, column }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const result = await deleteSheetColumn(sheet_id, ctx.userId, column, { bumpDataVersion: true });
      if ('fail' in result) {
        return err(result.fail === 'column_not_found' ? `Column "${column}" not found in this sheet` : result.error);
      }
      return ok({ deleted: true, trash: trashAnswer(ctx.userId, result.trashId, 'mcp', { moving: !!result.moving }) });
    },
  );

  registerTool(server, 
    'sort_sheet',
    {
      description:
        'Reorder a sheet\'s rows by one column, permanently (as a spreadsheet sorts): there is no live sort. '
        + 'To read rows in another order or a subset, use read_rows with where or a saved view instead. Row ids '
        + 'stay; indexes change. Refused while a run works on the sheet. Returns rows_reordered.',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID), column: z.string().describe('The column to sort by'),
        direction: z.enum(['asc', 'desc']).describe('asc: A to Z, smallest first; desc: the other way'),
      },
    },
    async ({ sheet_id, column, direction }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const result = await physicalSortSheet(sheet_id, ctx.userId, column, direction, { bumpDataVersion: true });
      if ('fail' in result) {
        if (result.fail === 'busy') return err(result.error);
        return err(result.fail === 'column_not_found' ? `Column "${column}" not found in this sheet` : result.message);
      }
      return ok({ rows_reordered: result.rowsReordered });
    },
  );

  // Same service and checks as REST PUT /v1/sheets/:id/columns/order.
  registerTool(server, 'set_column_order', {
    description:
      'Put a sheet\'s columns in a new order: every column, once, by its exact name (get_sheet lists them in their '
      + 'order now). Only the order the app and reads show changes: no row, cell, run or saved view changes, and a '
      + 'hidden column stays hidden. A column left out, named twice or unknown is refused and nothing changes.',
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      order: z.array(z.string()).min(1).max(MAX_COLUMNS_PER_SHEET).describe('Every column name, in the new order'),
    }).strict(),
  }, async ({ sheet_id, order }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
    const result = reorderSheetColumns(sheet_id, ctx.userId, order, { bumpDataVersion: true });
    return 'fail' in result ? err(result.error) : ok({ order });
  });
}
