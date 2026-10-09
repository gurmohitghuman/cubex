// Enrichment follow-ups: a column from stored answers, a list job's fields,
// and auto-run. Thin wrappers over services/enrich-agent-fields.ts and
// enrich-agent-autorun.ts (the same as /api/v1). Scope check first.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentAddField, agentAddListRows, agentListFields } from '../services/enrich-agent-fields';
import { agentSetAutorun } from '../services/enrich-agent-autorun';
import { DAILY_LIMIT_NOTE } from '../services/enrich-agent-shared';
import { AUTORUN_DEFAULT_DAILY_CAP_USD, AUTORUN_HTTP_DEFAULT_DAILY_ROWS } from '../lib/constants';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

const condition = z.object({
  column: z.string(),
  operator: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt']),
  value: z.string().optional(),
}).strict();

export function registerEnrichManageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'add_enrichment_field', {
    description:
      'Add a column filled from the answers an enrichment or HTTP API column already stored: free, no treg calls '
      + 'and no requests. column is the enrichment\'s status column (or one of its outputs, or an HTTP API column). '
      + 'Find json_path in a stored answer: get_run_results with include_answers:true shows them (paths start at the '
      + 'answer\'s root, e.g. $.output.company.linkedin_url or $.raw.location). Later runs of the column fill it too. '
      + 'It fills in the background: its cells read "⏳ Processing..." and the sheet refuses other changes until '
      + 'done. '
      + 'A part of an answer too big to keep, and columns that add rows to another sheet, are refused.',
    inputSchema: z.object({
      sheet_id: z.string(), column: z.string(), json_path: z.string().max(1000), column_name: z.string().max(200),
      row_id: z.string().optional().describe('The row whose answer you read the path from (checks that part was kept)'),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentAddField(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'get_list_fields', {
    description:
      'For an enrichment column that adds its results as rows in another sheet: the fields those results really '
      + 'have (path, label, how many results filled it, a sample), read from the results waiting for fields (after '
      + 'a run_enrichment test:true) or the column\'s newest stored results. waiting_for_fields counts the source rows '
      + 'and results that wait; kept lists the fields already picked. Pick with add_list_rows.',
    inputSchema: { sheet_id: z.string(), column: z.string().describe('The status column that adds rows') },
  }, async ({ sheet_id, column }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = agentListFields(ctx.userId, sheet_id, column);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'add_list_rows', {
    description:
      'Pick the fields to keep for a list job\'s results waiting for them (from get_list_fields), and add those '
      + 'results as rows in the destination sheet, one row per result: free, the results are already paid for. '
      + 'Each field becomes a column there (an existing column of that name is filled). dedupe_path (one of the '
      + 'fields) skips a result whose value matches a row added before. The column keeps these fields, so '
      + 'control_run rerun mode "empty" then runs the rest of the rows. Adding them costs nothing here, but auto-runs '
      + 'on the destination sheet fill new rows there: auto_run lists them, as for append_rows.',
    inputSchema: z.object({
      sheet_id: z.string(), column: z.string(),
      fields: z.array(z.object({ path: z.string(), column_name: z.string() }).strict()).min(1),
      dedupe_path: z.string().optional(),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentAddListRows(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'set_auto_run', {
    description:
      'Turn auto-run on or off for an enrichment or HTTP API column, or pause and resume it. With auto-run on, the '
      + 'column repeats its newest run on new rows and on rows whose inputs get filled (by an import, another column, '
      + 'a webhook or an edit), at most once a row; rows already in the sheet when it is turned on are left alone. '
      + 'enabled:true|false with column (and where: only rows matching; daily_cap_usd for an enrichment, '
      + `default $${AUTORUN_DEFAULT_DAILY_CAP_USD}, never above the daily limit; daily_row_cap for an HTTP API `
      + `column, default ${AUTORUN_HTTP_DEFAULT_DAILY_ROWS}). `
      + 'paused:true|false pauses or resumes one column, or every auto-run on the sheet without column. '
      + 'An enrichment auto-run SPENDS the treg balance on every new row; with a webhook on the sheet, anyone with '
      + 'its URL can add rows that spend. An HTTP API auto-run SENDS REAL REQUESTS (it can add leads to a sequencer '
      + `or send messages), once per row. ${DAILY_LIMIT_NOTE} Returns every auto-run on the sheet.`,
    inputSchema: z.object({
      sheet_id: z.string(), column: z.string().optional(),
      enabled: lenientBoolean().optional(), paused: lenientBoolean().optional(),
      where: z.array(condition).max(20).optional(),
      daily_cap_usd: z.number().positive().optional(),
      daily_row_cap: z.number().int().min(1).optional(),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await agentSetAutorun(ctx.userId, sheet_id, a, ctx.scopes.has('secrets'));
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
