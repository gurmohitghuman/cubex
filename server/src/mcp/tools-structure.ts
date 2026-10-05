// Workspace-structure tools (design-doc step 3b) — action-enum'd like
// control_run to keep the tool count low (the doc's finding: 30+ raw CRUD
// tools degrade agent tool selection). Same services as the /v1 table/sheet
// routes. MCP is the only client-facing surface, so agents must be able to
// provision tables/sheets, not just work inside existing ones.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTable, renameTable, deleteTable } from '../services/table-crud';
import { createSheet, renameSheet, deleteSheet, reorderSheets } from '../services/sheet-crud';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

export function registerStructureTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'manage_table',
    {
      description:
        `Create, rename, or delete a table (a workspace that holds one or more sheet tabs). create returns the new table with its first sheet ("Sheet1") ready for add_column/append_rows/import_csv. DELETE IS PERMANENT: it removes every sheet and row in the table and cancels its active runs.`,
      inputSchema: {
        action: z.enum(['create', 'rename', 'delete']),
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
      if (!table_id) return err(`table_id is required for ${action}`);
      const result = action === 'rename'
        ? renameTable(ctx.userId, table_id, name)
        : deleteTable(ctx.userId, table_id);
      if ('fail' in result) return err(result.message);
      return ok(result.ok);
    },
  );

  registerTool(server, 
    'manage_sheet',
    {
      description:
        `Create, rename, delete, or reorder the sheet tabs of a table (a table always keeps at least one sheet). create auto-names the sheet when name is omitted and can insert after a given tab. DELETE IS PERMANENT: it removes the sheet's rows and cancels its active runs. Returns the table's updated tab list.`,
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
      return action === 'delete' ? ok({ deleted: true, sheets: result.ok.sheets }) : ok(result.ok);
    },
  );
}
