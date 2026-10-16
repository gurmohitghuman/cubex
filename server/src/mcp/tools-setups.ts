import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteSetup, getSetup, listSetups, specSummary } from '../services/setup-library';
import { planSetup, saveSetup } from '../services/setup-save';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

// Setups: a saved copy of a chain of filled columns, to use again on another
// sheet (services/setup-*.ts). list_setups, save_setup, delete_setup.
export function registerSetupTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'list_setups', {
    description:
      'List the saved setups. A setup is a named copy of a chain of filled columns (AI, HTTP API, enrichment, '
      + 'clean data and formula columns, with their "Only run if" rules and auto-run), saved from one sheet to '
      + 'build the same columns on another. Each lists its steps, its inputs (the columns it reads that no step '
      + 'makes: the sheet it is used on needs columns for them) and the saved keys its requests name. Pass '
      + 'setup_id for one setup in full: every step\'s prompt, request, formula and settings.',
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

  registerTool(server, 'save_setup', {
    description:
      'Save filled columns of a sheet as a named setup, to build the same columns on another sheet later. Name '
      + 'any column a step made (an AI column\'s "(Output)", an HTTP API or enrichment status column or one of '
      + 'its output columns, a clean or formula column). include_upstream (default true) adds every filled '
      + 'column they read, down the chain, so the setup holds the whole flow. Each step is saved as its column '
      + 'is set up now: prompt, model, web search, output columns, request, JSONPaths, enrichment choices, '
      + 'formula, cleaner, "Only run if" and auto-run. Saved keys are kept by name, never their value. A column '
      + 'that adds rows to another sheet can\'t be saved. preview: true returns what the setup would hold (its '
      + 'steps in order, inputs and keys) and saves nothing. Saving changes nothing in the sheet.',
    inputSchema: z.object({
      sheet_id: z.string(),
      name: z.string().optional().describe('The setup\'s name; required unless preview is true'),
      description: z.string().optional().describe('What it does, in a sentence'),
      columns: z.array(z.string()).min(1).describe('The filled columns to save, by name'),
      include_upstream: lenientBoolean().optional().describe('Default true: add the filled columns they read'),
      preview: lenientBoolean().optional().describe('true: show what would be saved, save nothing'),
    }).strict(),
  }, async ({ sheet_id, name, description, columns, include_upstream, preview }) => {
    const denied = missingScope(ctx, preview ? 'read' : 'write');
    if (denied) return denied;
    if (preview) {
      const plan = planSetup(ctx.userId, sheet_id, columns, include_upstream !== false);
      return 'ok' in plan ? ok({ ...specSummary(plan.ok), spec: plan.ok }) : err(plan.message);
    }
    const out = saveSetup(ctx.userId, sheet_id, { name, description, columns, includeUpstream: include_upstream });
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'delete_setup', {
    description:
      'Delete a saved setup. PERMANENT: it can\'t be undone. Sheets the setup was used on keep their columns and '
      + 'values: a setup is a copy, never a link.',
    inputSchema: z.object({ setup_id: z.string() }).strict(),
  }, async ({ setup_id }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = deleteSetup(ctx.userId, setup_id);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
