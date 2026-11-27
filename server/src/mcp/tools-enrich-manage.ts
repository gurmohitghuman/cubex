// Enrichment follow-ups: stored_answers (a column from stored answers, a list job's results as rows), a list job's
// fields, and auto-run. Thin wrappers over services/enrich-agent-fields.ts and
// enrich-agent-autorun.ts (the same as /api/v1). Scope check first.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { agentAddField, agentAddListRows, agentListFields } from '../services/enrich-agent-fields';
import { agentSetAutorun } from '../services/enrich-agent-autorun';
import { DAILY_LIMIT_NOTE } from '../services/enrich-agent-shared';
import {
  AUTORUN_DEFAULT_DAILY_CAP_USD, AUTORUN_HTTP_DEFAULT_DAILY_ROWS, AUTORUN_MAX_START_DELAY_S,
} from '../lib/constants';
import { RULE_POINTER } from './run-if-schema';
import { MAX_RULE_CHARS } from '../lib/run-condition';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, SHEET_ID } from './tool-helpers';
import { capRunToolNote } from '../lib/token-spend';
import { GUIDE_POINTER } from './guides/guide';
import { actionFieldsProblem } from './action-fields';
import { changedOf } from './changed';

// stored_answers (add_enrichment_field and add_list_rows before v0.8.47): each action's fields, exported for
// REST's bodies (openapi/routes-fill.ts), which stay what the two tools took.
export const ADD_COLUMN_INPUT = {
  sheet_id: z.string().describe(SHEET_ID),
  column: z.string().describe('The enrichment\'s status column, one of its outputs, or an HTTP API column'),
  json_path: z.string().max(1000).describe('Where the value is in each stored answer, e.g. $.output.email'),
  column_name: z.string().max(200).describe('The new column\'s name'),
  row_id: z.string().optional().describe('The row whose answer you read the path from (checks that part was kept)'),
};
export const ADD_ROWS_INPUT = {
  sheet_id: z.string().describe(SHEET_ID), column: z.string().describe('The status column that adds rows'),
  fields: z.array(z.object({
    path: z.string().describe('A field\'s path, from get_list_fields'),
    column_name: z.string().describe('The destination column it fills (made if missing)'),
  }).strict()).min(1).describe('The fields to keep'),
  dedupe_path: z.string().optional().describe('A field whose value already added skips the result'),
};
const STORED_ACTIONS = ['add_column', 'add_rows'] as const;
type StoredField = 'json_path' | 'column_name' | 'row_id' | 'fields' | 'dedupe_path';
const STORED_TAKES = {
  add_column: { needs: ['json_path', 'column_name'], may: ['row_id'] },
  add_rows: { needs: ['fields'], may: ['dedupe_path'] },
} as const satisfies Record<typeof STORED_ACTIONS[number], { needs?: readonly StoredField[];
  may?: readonly StoredField[] }>;

const condition = z.object({
  column: z.string().describe('The column it reads'),
  operator: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt']).describe('How it compares'),
  value: z.string().optional().describe('What it compares with (not for empty and not_empty)'),
}).strict();

export function registerEnrichManageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_list_fields', {
    description:
      'For an enrichment column that adds its results as rows in another sheet: the fields those results really '
      + 'have (path, label, how many results filled it, a sample), read from the results waiting for fields (after '
      + 'a run_enrichment test:true) or the column\'s newest stored results. waiting_for_fields counts the source rows '
      + 'and results that wait; kept lists the fields already picked. Pick with stored_answers (action add_rows).',
    inputSchema: {
      sheet_id: z.string().describe(SHEET_ID), column: z.string().describe('The status column that adds rows'),
    },
  }, async ({ sheet_id, column }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = agentListFields(ctx.userId, sheet_id, column);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'stored_answers', {
    description:
      'Use the answers an enrichment or HTTP API column already stored, for FREE: no treg calls, no requests. '
      + 'add_column: a column filled from them by json_path; column is the enrichment\'s status column (or one of '
      + 'its outputs, or an HTTP API column); find json_path in a stored answer with get_run (action results) and '
      + 'include_answers:true (paths start at the answer\'s root, e.g. $.output.company.linkedin_url). Later runs '
      + 'of the column fill it too; it fills in the background (get_sheet\'s filling_columns says when it is done). '
      + 'add_rows: for a list job (a column that adds its results as rows in another sheet), pick the fields to '
      + 'keep (from get_list_fields) and add the results waiting for them as rows there, one row per result; each '
      + 'field becomes a column there. The column keeps these fields, so control_run rerun mode "empty" then runs '
      + 'the rest of the rows. Auto-runs on the destination sheet fill new rows there: auto_run lists them, as for '
      + `append_rows. ${GUIDE_POINTER}`,
    inputSchema: z.object({
      action: z.enum(STORED_ACTIONS).describe('add_column or add_rows'),
      sheet_id: z.string().describe(SHEET_ID),
      column: z.string().describe('add_column: the enrichment\'s status column, one of its outputs, or an HTTP API '
        + 'column; add_rows: the status column that adds rows'),
      json_path: ADD_COLUMN_INPUT.json_path.optional().describe('add_column: where the value is in each stored '
        + 'answer, e.g. $.output.email'),
      column_name: ADD_COLUMN_INPUT.column_name.optional().describe('add_column: the new column\'s name'),
      row_id: ADD_COLUMN_INPUT.row_id.describe('add_column: the row whose answer you read the path from (checks that '
        + 'part was kept)'),
      fields: ADD_ROWS_INPUT.fields.optional().describe('add_rows: the fields to keep'),
      dedupe_path: ADD_ROWS_INPUT.dedupe_path.describe('add_rows: a field whose value already added skips the result'),
    }).strict(),
  }, async ({ action, sheet_id, column, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const problem = actionFieldsProblem<typeof STORED_ACTIONS[number], StoredField>(action, a, STORED_TAKES);
    if (problem) return err(problem);
    if (action === 'add_column') {
      const { json_path, column_name, row_id } = a;
      const out = await agentAddField(ctx.userId, sheet_id,
        { column, json_path: json_path!, column_name: column_name!, row_id });
      if (!('ok' in out)) return err(out.message);
      return ok({ ...out.ok, changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [out.ok.column],
        moreComing: true }]) });
    }
    const fields = a.fields!;
    const out = await agentAddListRows(ctx.userId, sheet_id, { column, fields, dedupe_path: a.dedupe_path });
    if (!('ok' in out)) return err(out.message);
    // The rows are added in the background; each source row's status cell says when its are in.
    return ok({ ...out.ok, changed: changedOf(ctx.userId, [
      out.ok.source_rows_released > 0 && { sheetId: sheet_id, columns: [column], moreComing: true },
      !!out.destSheetId && { sheetId: out.destSheetId, moreComing: true,
        columns: fields.map((f: { column_name: string }) => f.column_name) },
    ]) });
  });

  registerTool(server, 'set_auto_run', {
    description:
      'Turn auto-run on or off for an enrichment or HTTP API column, or pause and resume it. When on, the column '
      + 'repeats its newest run on new rows and on rows whose inputs get filled, once a row; rows already there '
      + 'are left alone. '
      + 'An enrichment auto-run SPENDS the treg balance on every new row; with a webhook on the sheet, anyone with '
      + 'its URL can add rows that spend. An HTTP API auto-run SENDS REAL REQUESTS (leads to a sequencer, messages), '
      + `once per row. ${DAILY_LIMIT_NOTE} Returns every auto-run on the sheet.`
      + capRunToolNote(ctx.spend ?? null) + ` ${GUIDE_POINTER}`,
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      column: z.string().optional().describe('The column; with paused and no column, every auto-run on the sheet'),
      enabled: lenientBoolean().optional().describe('true turns auto-run on for column, false off'),
      paused: lenientBoolean().optional().describe('true pauses, false resumes'),
      waiting_rows: z.enum(['run', 'empty_only', 'skip']).optional().describe('On resume, the rows added or changed '
        + 'while paused: run (default) runs them, empty_only only those whose cell is empty, skip none (from now on)'),
      where: z.array(condition).max(20).optional().describe('Only rows passing every condition auto-run'),
      run_if: z.string().max(MAX_RULE_CHARS).optional().describe(
        'Auto-run\'s "Only run if" rule; rows that fail it wait (no marker) until a column it reads changes. Kept '
        + 'when omitted (a first turn-on takes the column\'s own rule); "" clears it. ' + RULE_POINTER),
      daily_cap_usd: z.number().positive().optional()
        .describe(`An enrichment's dollars a day (default ${AUTORUN_DEFAULT_DAILY_CAP_USD})`),
      daily_row_cap: z.number().int().min(1).optional()
        .describe(`An HTTP API column's rows a day (default ${AUTORUN_HTTP_DEFAULT_DAILY_ROWS})`),
      start_delay_s: z.number().int().min(0).max(AUTORUN_MAX_START_DELAY_S).nullable().optional()
        .describe('Seconds a row waits after its last change before it runs, so one still being filled in runs once '
          + 'done (default 0; kept when omitted)'),
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
