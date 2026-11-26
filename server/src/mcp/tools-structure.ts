// Workspace-structure tools (design-doc step 3b) — action-enum'd like
// control_run to keep the tool count low (the doc's finding: 30+ raw CRUD
// tools degrade agent tool selection). Same services as the /v1 table/sheet
// routes. MCP is the only client-facing surface, so agents must be able to
// provision tables/sheets, not just work inside existing ones.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { createTable, renameTable, deleteTable, setTableStarred } from '../services/table-crud';
import { createSheet, renameSheet, deleteSheet, reorderSheets } from '../services/sheet-crud';
import { copySheetValues, sheetCopyWindow } from '../services/sheet-copy';
import { tooManyMessage } from '../lib/rate-window';
import { verifySheetInTable } from '../lib/sheet-crud-helpers';
import { trashAnswer } from '../services/trash-answer';
import { createSampleTable } from '../services/sample-table';
import { sampleAnswer } from '../services/sample-answer';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, mcpLinkBase } from './tool-helpers';
import { runTestAction, TEST_ACTIONS, TEST_WORDS, type TestAction } from './tools-sheet-test';
import { changedOf } from './changed';
import { SHEET_TEST_MAX_ROWS } from '../lib/constants';
import { getSheetColumns } from '../lib/sql-helpers';
import { webhookForNewSheet, type SheetWebhookView } from '../services/sheet-webhook';
import { GUIDE_POINTER } from './guides/guide';

// What a create with webhook true adds to its answer.
type NewSheetWebhook = { webhook?: SheetWebhookView; webhook_error?: string };

export function registerStructureTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'manage_table',
    {
      description:
        'Create, rename, star or delete a table (it holds one or more sheet tabs; manage_sheet changes the tabs). '
        + 'create returns the new table with its first sheet ("Sheet1"); next: add_column, append_rows or import_csv. '
        + 'star puts it in the user\'s Favorites on the home (get_workspace with all_tables says starred), unstar '
        + 'takes it out. '
        + 'delete puts the table '
        + 'in the trash with all its sheets and rows, cancels its active runs and stops its webhooks; it is kept for '
        + 'the days set in Settings (30 by default; 0 deletes at once), and restore_from_trash brings it back whole. '
        + 'create_sample (no name needed) makes a new table named "Sample leads" (or "Sample leads 2"...) to try '
        + 'Cubex on: 25 made-up leads (invented people and companies, every website and email at .example, none '
        + 'of them real), with a clean column and a formula '
        + 'column filled for free, a dry-run duplicate check of the one duplicate it holds, and an AI column set up '
        + 'but NOT run: it costs money, so run it (the answer says how) only after the user agrees.',
      inputSchema: {
        action: z.enum(['create', 'rename', 'star', 'unstar', 'delete', 'create_sample']).describe('What to do'),
        table_id: z.string().optional().describe('rename, star, unstar, delete: the table (get_workspace)'),
        name: z.string().optional().describe('Required for create/rename'),
        webhook: lenientBoolean().optional()
          .describe('create: true gives its first sheet an incoming webhook (manage_sheet_webhook)'),
      },
    },
    async ({ action, table_id, name, webhook }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (webhook !== undefined && action !== 'create') return err('webhook is for create.');
      if (action === 'create') {
        const result = createTable(ctx.userId, name);
        if ('fail' in result) return err(result.message);
        const hook: NewSheetWebhook = webhook
          ? webhookForNewSheet(ctx.userId, result.ok.sheetId, mcpLinkBase(ctx)) : {};
        return ok({
          id: result.ok.id, name: result.ok.name,
          sheets: [{ id: result.ok.sheetId, name: 'Sheet1', position: 0, row_count: 0 }], ...hook,
          changed: changedOf(ctx.userId, [{ sheetId: result.ok.sheetId,
            columns: hook.webhook ? [hook.webhook.column] : [] }]),
        });
      }
      if (action === 'create_sample') {
        const result = await createSampleTable(ctx.userId);
        if ('fail' in result) return err(result.message);
        const { sheetId, rows } = result.ok;
        return ok({ ...sampleAnswer(result.ok, 'mcp'), changed: changedOf(ctx.userId,
          [{ sheetId, columns: getSheetColumns(sheetId, ctx.userId, false), rows }]) });
      }
      if (!table_id) return err(`table_id is required for ${action}`);
      if (action === 'rename') {
        const result = renameTable(ctx.userId, table_id, name);
        return 'fail' in result ? err(result.message) : ok({ ...result.ok, changed: [] });
      }
      if (action === 'star' || action === 'unstar') {
        // Nothing in the table changes: no sheet to name in changed.
        const result = setTableStarred(ctx.userId, table_id, action === 'star');
        return 'fail' in result ? err(result.message) : ok({ ...result.ok, changed: [] });
      }
      const result = deleteTable(ctx.userId, table_id);
      if ('fail' in result) return err(result.message);
      return ok({ deleted: true, trash: trashAnswer(ctx.userId, result.ok.trashId, 'mcp'), changed: [] });
    },
  );

  registerTool(server, 
    'manage_sheet',
    {
      description:
        'Create, rename, copy, delete or reorder the sheet tabs of a table (a table always keeps at least one sheet). '
        + 'copy makes a new sheet right after sheet_id holding its values only, as plain columns that nothing fills '
        + '(free, no AI). delete puts the sheet '
        + 'in the trash whole (rows, columns, runs, views, webhook), cancels its active runs and stops its webhook; '
        + 'it is kept for the days set in Settings (30 by default; 0 deletes at once), and restore_from_trash brings '
        + 'it back. Enrichment results its columns bought that were not yet added as rows in another sheet are '
        + 'dropped (list_results_dropped says how many and for which sheets). Returns the table\'s updated tab list. '
        + `${TEST_WORDS} ${GUIDE_POINTER}`,
      inputSchema: {
        action: z.enum(['create', 'rename', 'copy', 'delete', 'reorder', ...TEST_ACTIONS]).describe('What to do'),
        table_id: z.string().describe('The table (get_workspace)'),
        sheet_id: z.string().optional()
          .describe('Required for rename/copy/delete and the test actions (the sheet or its test copy)'),
        name: z.string().optional().describe('create and copy: optional; rename: required'),
        columns: z.array(z.string()).min(1).optional()
          .describe('copy only: the columns to copy, in this order (default: every column)'),
        after_sheet_id: z.string().optional()
          .describe('create only: insert after this tab; an unknown id appends at the end'),
        ordered_sheet_ids: z.array(z.string()).min(1).optional()
          .describe('reorder only: every sheet id of the table, in the desired order'),
        webhook: lenientBoolean().optional()
          .describe('create: true gives the new sheet an incoming webhook (manage_sheet_webhook)'),
        row_ids: z.array(z.string()).min(1).optional().describe('test, test_add_rows: the rows to take'),
        rows: z.number().int().min(1).max(SHEET_TEST_MAX_ROWS).optional()
          .describe('test, test_add_rows: how many rows (default 10)'),
        how: z.enum(['top', 'random']).optional()
          .describe('test_add_rows: the next rows from the top (default), or random'),
        dry_run: lenientBoolean().optional().describe('apply_test: false applies; default true'),
      },
    },
    async ({ action, table_id, sheet_id, name, columns, after_sheet_id, ordered_sheet_ids, webhook, ...test }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (webhook !== undefined && action !== 'create') return err('webhook is for create.');
      if ((TEST_ACTIONS as readonly string[]).includes(action)) {
        return runTestAction(ctx, action as TestAction, { table_id, sheet_id, ...test });
      }
      if (action === 'create') {
        const result = createSheet(ctx.userId, table_id, name, after_sheet_id);
        if ('fail' in result) return err(result.message);
        const made = result.ok.sheet;
        const hook: NewSheetWebhook = webhook && made
          ? webhookForNewSheet(ctx.userId, made.id, mcpLinkBase(ctx)) : {};
        return ok({ ...result.ok, ...hook, changed: changedOf(ctx.userId,
          [made && { sheetId: made.id, columns: hook.webhook ? [hook.webhook.column] : [] }]) });
      }
      if (action === 'copy') {
        if (!sheet_id) return err('sheet_id is required for copy');
        if (!verifySheetInTable(sheet_id, table_id, ctx.userId)) return err('Sheet not found');
        const slot = sheetCopyWindow(ctx.tokenId);
        if (!slot.allowed) return err(tooManyMessage('sheet copies', slot));
        const result = await copySheetValues(ctx.userId, sheet_id, { name, columns });
        if ('fail' in result) return err(result.message);
        const { sheet, sheets, rowsCopied, columns: copied } = result.ok;
        return ok({
          sheet, sheets, rows_copied: rowsCopied, columns: copied,
          changed: changedOf(ctx.userId, [sheet && { sheetId: sheet.id, columns: copied, rows: rowsCopied }]),
        });
      }
      if (action === 'reorder') {
        if (!ordered_sheet_ids) return err('ordered_sheet_ids is required for reorder');
        const result = reorderSheets(ctx.userId, table_id, ordered_sheet_ids);
        return 'fail' in result ? err(result.message) : ok({ ...result.ok, changed: [] });
      }
      if (!sheet_id) return err(`sheet_id is required for ${action}`);
      const result = action === 'rename'
        ? renameSheet(ctx.userId, table_id, sheet_id, name)
        : deleteSheet(ctx.userId, table_id, sheet_id);
      if ('fail' in result) return err(result.message);
      if (action !== 'delete') return ok({ ...result.ok, changed: [] });
      const dropped = result.ok.notAdded;
      return ok({
        deleted: true, sheets: result.ok.sheets, trash: trashAnswer(ctx.userId, result.ok.trashId ?? null, 'mcp'),
        ...(dropped ? { list_results_dropped: dropped } : {}), changed: [],
      });
    },
  );
}
