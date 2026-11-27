import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { deleteSetup, getSetup, listSetups, specSummary } from '../services/setup-library';
import { planSetup, saveSetup } from '../services/setup-save';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';
import { actionFieldsProblem } from './action-fields';

// Setups: a saved copy of a chain of filled columns, to use again on another
// sheet (services/setup-*.ts). list_setups, and manage_setup (save_setup and delete_setup before v0.8.47).
const ACTIONS = ['save', 'delete'] as const;
type Field = 'sheet_id' | 'name' | 'description' | 'columns' | 'include_upstream' | 'preview' | 'setup_id';
const TAKES = {
  save: { needs: ['sheet_id', 'columns'], may: ['name', 'description', 'include_upstream', 'preview'] },
  delete: { needs: ['setup_id'] },
} as const satisfies Record<typeof ACTIONS[number], { needs?: readonly Field[]; may?: readonly Field[] }>;

export function registerSetupTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'list_setups', {
    description:
      'List the saved setups. A setup is a named copy of a chain of filled columns (AI, HTTP API, enrichment, '
      + 'clean data and formula columns, with their "Only run if" rules and auto-run), saved from one sheet to '
      + 'build the same columns on another. Each lists its steps, its inputs (the columns it reads that no step '
      + 'makes: the sheet it is used on needs columns for them) and the saved keys its requests name. Pass '
      + 'setup_id for one setup in full: every step\'s prompt, request, formula and settings. Read-only. Next: '
      + 'apply_setup on a sheet.',
    inputSchema: z.object({
      setup_id: z.string().optional().describe('One setup in full; leave out for the list'),
    }).strict(),
  }, async ({ setup_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (setup_id === undefined) return ok({ setups: listSetups(ctx.userId) });
    const setup = getSetup(ctx.userId, setup_id);
    return setup ? ok(setup) : err('Setup not found');
  });

  registerTool(server, 'manage_setup', {
    description:
      'Save a setup, or delete one. A setup is a named copy of a chain of filled columns. save: Save filled columns '
      + 'of a sheet as a named setup, to build the same columns on another sheet later. Name any column a step made '
      + '(an AI column\'s "(Output)", an HTTP API or enrichment status column or one of its output columns, a clean '
      + 'or formula column). include_upstream (default true) adds every filled column they read, down the chain, so '
      + 'the setup holds the whole flow. Saving changes nothing in the sheet. delete: PERMANENT, it can\'t be '
      + 'undone; sheets the setup was used on keep their columns and values (a setup is a copy, never a link). '
      + GUIDE_POINTER,
    inputSchema: z.object({
      action: z.enum(ACTIONS).describe('save or delete'),
      sheet_id: z.string().optional().describe(`save: ${SHEET_ID}`),
      name: z.string().optional().describe('save: the setup\'s name; required unless preview is true'),
      description: z.string().optional().describe('save: what it does, in a sentence'),
      columns: z.array(z.string()).min(1).optional().describe('save: the filled columns to save, by name'),
      include_upstream: lenientBoolean().optional().describe('save: default true, add the filled columns they read'),
      preview: lenientBoolean().optional().describe('save: true shows what would be saved, saving nothing'),
      setup_id: z.string().optional().describe('delete: the setup (list_setups)'),
    }).strict(),
  }, async ({ action, ...a }) => {
    const denied = missingScope(ctx, action === 'save' && a.preview ? 'read' : 'write');
    if (denied) return denied;
    const problem = actionFieldsProblem<typeof ACTIONS[number], Field>(action, a, TAKES);
    if (problem) return err(problem);
    if (action === 'delete') {
      const out = deleteSetup(ctx.userId, a.setup_id!);
      return 'ok' in out ? ok(out.ok) : err(out.message);
    }
    const { sheet_id, name, description, columns, include_upstream, preview } = a;
    if (preview) {
      const plan = planSetup(ctx.userId, sheet_id!, columns!, include_upstream !== false);
      return 'ok' in plan ? ok({ ...specSummary(plan.ok), spec: plan.ok }) : err(plan.message);
    }
    const out = saveSetup(ctx.userId, sheet_id!, { name, description, columns: columns!,
      includeUpstream: include_upstream });
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
