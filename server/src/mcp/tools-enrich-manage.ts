// Enrichment follow-ups: a column from stored answers, a list job's fields,
// and auto-run. Thin wrappers over services/enrich-agent-fields.ts and
// enrich-agent-autorun.ts (the same as /api/v1). Scope check first.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { agentAddField, agentAddListRows, agentListFields } from '../services/enrich-agent-fields';
import { agentSetAutorun } from '../services/enrich-agent-autorun';
import { DAILY_LIMIT_NOTE } from '../services/enrich-agent-shared';
import { AUTORUN_DEFAULT_DAILY_CAP_USD, AUTORUN_HTTP_DEFAULT_DAILY_ROWS } from '../lib/constants';
import { RULE_POINTER } from './run-if-schema';
import { MAX_RULE_CHARS } from '../lib/run-condition';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, SHEET_ID } from './tool-helpers';
import { capToolNote } from '../lib/token-spend';
import { changedOf } from './changed';

const condition = z.object({
  column: z.string().describe('The column it reads'),
  operator: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt']).describe('How it compares'),
  value: z.string().optional().describe('What it compares with (not for empty and not_empty)'),
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
      + 'A part of an answer too big to keep, and columns that add rows to another sheet, are refused. Returns '
      + 'the column and whether it is still filling: get_sheet\'s filling_columns says when it is done.',
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      column: z.string().describe('The enrichment\'s status column, one of its outputs, or an HTTP API column'),
      json_path: z.string().max(1000).describe('Where the value is in each stored answer, e.g. $.output.email'),
      column_name: z.string().max(200).describe('The new column\'s name'),
      row_id: z.string().optional().describe('The row whose answer you read the path from (checks that part was kept)'),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentAddField(ctx.userId, sheet_id, a);
    if (!('ok' in out)) return err(out.message);
    return ok({ ...out.ok, changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [out.ok.column],
      moreComing: true }]) });
  });

  registerTool(server, 'get_list_fields', {
    description:
      'For an enrichment column that adds its results as rows in another sheet: the fields those results really '
      + 'have (path, label, how many results filled it, a sample), read from the results waiting for fields (after '
      + 'a run_enrichment test:true) or the column\'s newest stored results. waiting_for_fields counts the source rows '
      + 'and results that wait; kept lists the fields already picked. Pick with add_list_rows.',
    inputSchema: {
      sheet_id: z.string().describe(SHEET_ID), column: z.string().describe('The status column that adds rows'),
    },
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
      sheet_id: z.string().describe(SHEET_ID), column: z.string().describe('The status column that adds rows'),
      fields: z.array(z.object({
        path: z.string().describe('A field\'s path, from get_list_fields'),
        column_name: z.string().describe('The destination column it fills (made if missing)'),
      }).strict()).min(1).describe('The fields to keep'),
      dedupe_path: z.string().optional().describe('A field whose value already added skips the result'),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentAddListRows(ctx.userId, sheet_id, a);
    if (!('ok' in out)) return err(out.message);
    // The rows are added in the background; each source row's status cell says when its are in.
    return ok({ ...out.ok, changed: changedOf(ctx.userId, [
      out.ok.source_rows_released > 0 && { sheetId: sheet_id, columns: [a.column], moreComing: true },
      !!out.destSheetId && { sheetId: out.destSheetId, moreComing: true,
        columns: a.fields.map((f: { column_name: string }) => f.column_name) },
    ]) });
  });

  registerTool(server, 'set_auto_run', {
    description:
      'Turn auto-run on or off for an enrichment or HTTP API column, or pause and resume it. With auto-run on, the '
      + 'column repeats its newest run on new rows and on rows whose inputs get filled (by an import, another column, '
      + 'a webhook or an edit), at most once a row; rows already in the sheet when it is turned on are left alone. '
      + 'A clean column (clean_column) follows its source instead: turning it on cleans every row again, then each '
      + 'new row and each row whose source changes; it is free and takes no run_if or caps. A formula column '
      + '(formula_column) follows every column its formula reads the same way; turning it on again also lifts a '
      + 'pause (a formula that ran too slow). '
      + 'enabled:true|false with column (and run_if: only rows passing a rule, kept as is when omitted, and by '
      + 'default the column\'s own rule on a first turn-on, "" to clear; daily_cap_usd for an enrichment, '
      + `default $${AUTORUN_DEFAULT_DAILY_CAP_USD}, never above the daily limit; daily_row_cap for an HTTP API `
      + `column, default ${AUTORUN_HTTP_DEFAULT_DAILY_ROWS}). `
      + 'paused:true|false pauses or resumes one column, or every auto-run on the sheet without column. '
      + 'An enrichment auto-run SPENDS the treg balance on every new row; with a webhook on the sheet, anyone with '
      + 'its URL can add rows that spend. An HTTP API auto-run SENDS REAL REQUESTS (it can add leads to a sequencer '
      + `or send messages), once per row. ${DAILY_LIMIT_NOTE} Returns every auto-run on the sheet.`
      + capToolNote(ctx.spend ?? null, true),
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      column: z.string().optional().describe('The column; with paused and no column, every auto-run on the sheet'),
      enabled: lenientBoolean().optional().describe('true turns auto-run on for column, false off'),
      paused: lenientBoolean().optional().describe('true pauses, false resumes'),
      where: z.array(condition).max(20).optional().describe('Only rows passing every condition auto-run'),
      run_if: z.string().max(MAX_RULE_CHARS).optional().describe(
        'Auto-run\'s "Only run if" rule; rows that fail it wait (no marker) until a column it reads changes. '
        + RULE_POINTER),
      daily_cap_usd: z.number().positive().optional()
        .describe(`An enrichment's dollars a day (default ${AUTORUN_DEFAULT_DAILY_CAP_USD})`),
      daily_row_cap: z.number().int().min(1).optional()
        .describe(`An HTTP API column's rows a day (default ${AUTORUN_HTTP_DEFAULT_DAILY_ROWS})`),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await agentSetAutorun(ctx.userId, sheet_id, a, ctx.scopes.has('secrets'));
    if (!('ok' in out)) return err(out.message);
    // Turned on or resumed, it fills rows on its own from now on.
    return ok({ ...out.ok, changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: a.column ? [a.column] : [],
      moreComing: a.enabled === true || a.paused === false }]) });
  });
}
