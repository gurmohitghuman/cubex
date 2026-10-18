// Workspace-structure tools (design-doc step 3b) — action-enum'd like
// control_run to keep the tool count low (the doc's finding: 30+ raw CRUD
// tools degrade agent tool selection). Same services as the /v1 table/sheet
// routes. MCP is the only client-facing surface, so agents must be able to
// provision tables/sheets, not just work inside existing ones.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTable, renameTable, deleteTable } from '../services/table-crud';
import { createSheet, renameSheet, deleteSheet, reorderSheets } from '../services/sheet-crud';
import { trashAnswer } from '../services/trash-answer';
import { createSampleTable } from '../services/sample-table';
import { sampleAnswer } from '../services/sample-answer';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

export function registerStructureTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'manage_table',
    {
      description:
        'Create, rename, or delete a table (a workspace that holds one or more sheet tabs). create returns the new '
        + 'table with its first sheet ("Sheet1") ready for add_column/append_rows/import_csv. delete puts the table '
        + 'in the trash with all its sheets and rows, cancels its active runs and stops its webhooks; it is kept for '
        + 'the days set in Settings (30 by default; 0 deletes at once), and restore_from_trash brings it back whole. '
        + 'create_sample (no name needed) makes a new table named "Sample leads" (or "Sample leads 2"...) to try '
        + 'Cubex on: 25 made-up leads (invented people and companies, every website and email at .example, none '
        + 'of them real), with a clean column and a formula '
        + 'column filled for free, a dry-run duplicate check of the one duplicate it holds, and an AI column set up '
        + 'but NOT run: it costs money, so run it (the answer says how) only after the user agrees.',
      inputSchema: {
        action: z.enum(['create', 'rename', 'delete', 'create_sample']),
        table_id: z.string().optional().describe('Required for rename/delete'),
        name: z.string().optional().describe('Required for create/rename'),
      },
    },
    async ({ action, table_id, name }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (action === 'create') {
        const result = createTable(ctx.userId, name);
        if ('fail' in result) return err(result.message);
        return ok({
          id: result.ok.id, name: result.ok.name,
          sheets: [{ id: result.ok.sheetId, name: 'Sheet1', position: 0, row_count: 0 }],
        });
      }
      if (action === 'create_sample') {
        const result = await createSampleTable(ctx.userId);
        return 'fail' in result ? err(result.message) : ok(sampleAnswer(result.ok, 'mcp'));
      }
      if (!table_id) return err(`table_id is required for ${action}`);
      if (action === 'rename') {
        const result = renameTable(ctx.userId, table_id, name);
        return 'fail' in result ? err(result.message) : ok(result.ok);
      }
      const result = deleteTable(ctx.userId, table_id);
      if ('fail' in result) return err(result.message);
      return ok({ deleted: true, trash: trashAnswer(ctx.userId, result.ok.trashId, 'mcp') });
    },
  );

  registerTool(server, 
    'manage_sheet',
    {
      description:
        'Create, rename, delete, or reorder the sheet tabs of a table (a table always keeps at least one sheet). '
        + 'create auto-names the sheet when name is omitted and can insert after a given tab. delete puts the sheet '
        + 'in the trash whole (rows, columns, runs, views, webhook), cancels its active runs and stops its webhook; '
        + 'it is kept for the days set in Settings (30 by default; 0 deletes at once), and restore_from_trash brings '
        + 'it back. Enrichment results its columns bought that were not yet added as rows in another sheet are '
        + 'dropped (list_results_dropped says how many and for which sheets). Returns the table\'s updated tab list.',
      inputSchema: {
        action: z.enum(['create', 'rename', 'delete', 'reorder']),
        table_id: z.string(),
        sheet_id: z.string().optional().describe('Required for rename/delete'),
        name: z.string().optional().describe('create: optional; rename: required'),
        after_sheet_id: z.string().optional()
          .describe('create only: insert after this tab; an unknown id appends at the end'),
        ordered_sheet_ids: z.array(z.string()).min(1).optional()
          .describe('reorder only: every sheet id of the table, in the desired order'),
      },
    },
    async ({ action, table_id, sheet_id, name, after_sheet_id, ordered_sheet_ids }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      if (action === 'create') {
        const result = createSheet(ctx.userId, table_id, name, after_sheet_id);
        return 'fail' in result ? err(result.message) : ok(result.ok);
      }
      if (action === 'reorder') {
        if (!ordered_sheet_ids) return err('ordered_sheet_ids is required for reorder');
        const result = reorderSheets(ctx.userId, table_id, ordered_sheet_ids);
        return 'fail' in result ? err(result.message) : ok(result.ok);
      }
      if (!sheet_id) return err(`sheet_id is required for ${action}`);
      const result = action === 'rename'
        ? renameSheet(ctx.userId, table_id, sheet_id, name)
        : deleteSheet(ctx.userId, table_id, sheet_id);
      if ('fail' in result) return err(result.message);
      if (action !== 'delete') return ok(result.ok);
      const dropped = result.ok.notAdded;
      return ok({
        deleted: true, sheets: result.ok.sheets, trash: trashAnswer(ctx.userId, result.ok.trashId ?? null, 'mcp'),
        ...(dropped ? { list_results_dropped: dropped } : {}),
      });
    },
  );
}
