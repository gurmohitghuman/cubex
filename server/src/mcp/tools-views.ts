// manage_view: create, change and delete a sheet's saved views. The same
// service as the app and REST /v1/sheets/:id/views (services/views.ts), so the
// checks, limits and the sheet's History lines are the same; get_sheet lists
// views and read_rows, export_csv and create_download_link read through one.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createView, deleteView, updateView, type ViewOutcome } from '../services/views';
import { MAX_VIEWS_PER_SHEET } from '../lib/constants-filters';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { whereSchema } from './where-schema';

const answer = (out: ViewOutcome) => ('fail' in out ? err(out.message) : ok({ view: out.ok }));

export function registerViewTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'manage_view', {
    description:
      'Create, change or delete a saved view of a sheet: a name, a description, filters (a where) and hidden '
      + 'columns. A view never sorts, changes the column order or touches rows; get_sheet lists the views, and '
      + 'read_rows, export_csv and create_download_link read through one with view. action create makes a copy '
      + 'of the view the app shows (or of from), then sets what you pass: name is required and unique in the '
      + `sheet, ignoring case; a sheet has at most ${MAX_VIEWS_PER_SHEET} views. It never switches the view `
      + 'the app shows. change sets only what you pass on view: where and hidden_columns replace what the view '
      + 'had, null clears them (a view with no filters shows every row). delete deletes view (never rows or '
      + 'columns); the Default view can\'t be deleted, and deleting the view the app shows switches it to Default. '
      + 'Each change is a line in the sheet\'s History.',
    inputSchema: z.object({
      sheet_id: z.string(),
      action: z.enum(['create', 'change', 'delete']),
      view: z.string().optional().describe('change and delete: the view, by name or id'),
      name: z.string().optional().describe('create: required; change: the new name'),
      description: z.string().nullable().optional().describe('What the view is for, in a sentence; null clears it'),
      from: z.string().optional().describe('create only: the view to copy, by name or id (default: the one showing)'),
      where: whereSchema.nullable().optional().describe('The view\'s filters (the where language); null clears them'),
      hidden_columns: z.array(z.string()).max(MAX_COLUMNS_PER_SHEET).nullable().optional()
        .describe('Column names the view hides (at least one column stays showing); null or [] shows every column'),
    }).strict(),
  }, async ({ sheet_id, action, view, name, description, from, where, hidden_columns }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    if (action === 'create') {
      if (view !== undefined) return err('create makes a new view: leave view out (from picks the view to copy).');
      return answer(createView(sheet_id, ctx.userId, { name, description, from, where, hidden_columns }));
    }
    if (!view) return err(`${action} needs view, a view's name or id (get_sheet lists them).`);
    if (from !== undefined) return err('from is only for create.');
    if (action === 'delete') {
      const out = deleteView(sheet_id, ctx.userId, view);
      return 'fail' in out ? err(out.message) : ok({ ok: true });
    }
    const changes = { name, description, where, hidden_columns };
    if (Object.values(changes).every(v => v === undefined)) {
      return err('change needs at least one of name, description, where or hidden_columns.');
    }
    return answer(updateView(sheet_id, ctx.userId, view, changes));
  });
}
