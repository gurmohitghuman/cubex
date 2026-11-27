// manage_column: add, rename, describe, reorder or delete a sheet's columns, on the shared cascade services
// (column-add/-rename/-delete, column-reorder, descriptions), with the same rules as /api/v1 and the app.
// Each action's fields are its old tool's (add_column, rename_column, set_description, set_column_order,
// delete_column, before v0.8.47); a field another action takes is refused. Sorting rows is manage_sheet's sort.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { db } from '../lib/db';
import { addSheetColumn } from '../services/column-add';
import { renameSheetColumn } from '../services/column-rename';
import { deleteSheetColumn } from '../services/column-delete';
import { trashAnswer } from '../services/trash-answer';
import { describeColumn, descriptionProblem } from '../services/descriptions';
import { reorderSheetColumns } from '../services/column-reorder';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { McpAuthCtx, ok, err, missingScope, registerTool, SHEET_ID } from './tool-helpers';
import { changedOf } from './changed';
import { GUIDE_POINTER } from './guides/guide';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(sheetId, userId);

type Action = 'add' | 'rename' | 'describe' | 'reorder' | 'delete';
type Field = 'name' | 'column' | 'new_name' | 'description' | 'order';
// What each action takes: required, then optional.
const TAKES: Record<Action, { needs: Field[]; may?: Field[] }> = {
  add: { needs: ['name'], may: ['description'] },
  rename: { needs: ['column', 'new_name'] },
  describe: { needs: ['column', 'description'] },
  reorder: { needs: ['order'] },
  delete: { needs: ['column'] },
};

// Why the fields given don't fit the action, or null.
function fieldsProblem(action: Action, given: Partial<Record<Field, unknown>>): string | null {
  const { needs, may = [] } = TAKES[action];
  const takes = [...needs, ...may];
  const extra = (Object.keys(given) as Field[]).filter(f => given[f] !== undefined && !takes.includes(f));
  if (extra.length) return `${extra.join(' and ')} ${extra.length > 1 ? 'are' : 'is'} not for ${action}: it takes `
    + `${takes.join(', ')}.`;
  const missing = needs.filter(f => given[f] === undefined);
  return missing.length ? `${action} needs ${missing.join(' and ')}.` : null;
}

export function registerColumnTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server,
    'manage_column',
    {
      description:
        'Add, rename, describe, reorder or delete a sheet\'s columns. add: an empty column at the end, to write '
        + 'into with append_rows or change_rows (formula_column, clean_column, lookup_column, run_ai_column, '
        + 'run_enrichment and waterfall_column make their own column, filled from each row). rename: everything '
        + 'that names the column follows. describe: what it holds, for people and agents; "" clears it. reorder: '
        + 'every column once, by its exact name (get_sheet lists them in their order now). delete: to the trash '
        + `with its cells and its own setup (restore_from_trash). ${GUIDE_POINTER}`,
      inputSchema: {
        action: z.enum(['add', 'rename', 'describe', 'reorder', 'delete']).describe('What to do'),
        sheet_id: z.string().describe(SHEET_ID),
        name: z.string().optional().describe('add: the new column\'s name'),
        column: z.string().optional().describe('rename, describe, delete: the column\'s name now'),
        new_name: z.string().optional().describe('rename: its new name'),
        description: z.string().optional()
          .describe('describe, or add (optional): what the column holds, for people and agents; "" clears it'),
        order: z.array(z.string()).min(1).max(MAX_COLUMNS_PER_SHEET).optional()
          .describe('reorder: every column name, in the new order'),
      },
    },
    async ({ action, sheet_id, ...fields }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const problem = fieldsProblem(action, fields);
      if (problem) return err(problem);
      if (!ownsSheet(sheet_id, ctx.userId)) return err('Sheet not found');
      const { name, column, new_name, description, order } = fields;
      const notFound = `Column "${column}" not found in this sheet`;
      if (action === 'add') {
        const wrong = descriptionProblem(description, 'column');
        if (wrong) return err(wrong);
        const result = addSheetColumn(sheet_id, ctx.userId, name!, { bumpDataVersion: true, seedEmptyRow: false });
        if ('fail' in result) return err(result.error);
        const changed = () => changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [result.name] }]);
        if (description === undefined) return ok({ name: result.name, changed: changed() });
        const described = describeColumn(sheet_id, ctx.userId, result.name, description);
        return ok({ name: result.name, ...('ok' in described ? described.ok : {}), changed: changed() });
      }
      if (action === 'describe') {
        const outcome = describeColumn(sheet_id, ctx.userId, column!, description!);
        if ('fail' in outcome) return err(outcome.message);
        return ok({ column: column!, description: outcome.ok.description,
          changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [column!] }]) });
      }
      if (action === 'rename') {
        const result = await renameSheetColumn(sheet_id, ctx.userId, column!, new_name!, { bumpDataVersion: true });
        if ('fail' in result) return err(result.fail === 'column_not_found' ? notFound : result.error);
        return ok({
          name: result.newName, changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [result.newName] }]),
        });
      }
      if (action === 'reorder') {
        const result = reorderSheetColumns(sheet_id, ctx.userId, order!, { bumpDataVersion: true });
        return 'fail' in result ? err(result.error)
          : ok({ order: order!, changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: order! }]) });
      }
      const result = await deleteSheetColumn(sheet_id, ctx.userId, column!, { bumpDataVersion: true });
      if ('fail' in result) return err(result.fail === 'column_not_found' ? notFound : result.error);
      // A big column's cells move to the trash in the background (trash state "moving").
      return ok({
        deleted: true, trash: trashAnswer(ctx.userId, result.trashId, 'mcp', { moving: !!result.moving }),
        changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [column!], moreComing: !!result.moving }]),
      });
    },
  );
}
