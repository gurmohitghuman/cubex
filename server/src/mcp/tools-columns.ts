// Column + sort tools — the shared cascade services (column-add/-rename/
// -delete, sheet-sort), identical invariants to /api/v1 and the UI.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../lib/db';
import { addSheetColumn } from '../services/column-add';
import { renameSheetColumn } from '../services/column-rename';
import { deleteSheetColumn } from '../services/column-delete';
import { physicalSortSheet } from '../services/sheet-sort';
import { describeColumn, describeSheet, descriptionProblem } from '../services/descriptions';
import { MAX_COLUMN_DESCRIPTION_CHARS, MAX_SHEET_DESCRIPTION_CHARS } from '../lib/constants-columns';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(sheetId, userId);

export function registerColumnTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'add_column',
    {
      description:
        'Add a column (empty on every existing row). ' +
        'Names are Google-Sheets-permissive; case/token variants of existing names are rejected. ' +
        'description (optional) says what the column holds, as set_description does.',
      inputSchema: {
        sheet_id: z.string(), name: z.string(),
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
        sheet_id: z.string(),
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
        'Rename a column. Cascades everywhere (cell data, ordering, filters, webhook mappings, and the ' +
        '/references in saved AI prompts and HTTP request templates). Fails while an active run either ' +
        'WRITES this column or READS it (an AI prompt or an HTTP request): the remaining rows would lose ' +
        'its values. Stop the run first.',
      inputSchema: { sheet_id: z.string(), column: z.string(), new_name: z.string() },
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
        'PERMANENTLY delete a column and its data from every row (there is no undo). Fails for run-owned ' +
        'columns, columns an active run reads, webhook marker columns, and the last remaining column.',
      inputSchema: { sheet_id: z.string(), column: z.string() },
    },
    async ({ sheet_id, column }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const result = await deleteSheetColumn(sheet_id, ctx.userId, column, { bumpDataVersion: true });
      if ('fail' in result) {
        return err(result.fail === 'column_not_found' ? `Column "${column}" not found in this sheet` : result.error);
      }
      return ok({ deleted: true });
    },
  );

  registerTool(server, 
    'sort_sheet',
    {
      description:
        'ONE-TIME physical sort (Google Sheets semantics): rows are permanently reordered by the column; ' +
        'there is no live sort view. Row ids stay stable; row indexes change. Fails while any run is active.',
      inputSchema: { sheet_id: z.string(), column: z.string(), direction: z.enum(['asc', 'desc']) },
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
}
