// waterfall_column: one value per row from ordered steps, stopping at the
// first answer. A thin wrapper over services/waterfall-token-run.ts, the same
// implementation POST /api/v1/sheets/:id/waterfall-columns uses. The scope
// check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ENRICH_DEFAULT_CONCURRENCY, ENRICH_TEST_ROWS, HTTP_MAX_CONCURRENCY, HTTP_RETRY_MAX, WATERFALL_LABEL_MAX_CHARS,
  WATERFALL_MAX_ALTERNATIVES, WATERFALL_MAX_STEPS, WATERFALL_PROMPT_MAX_CHARS, WATERFALL_DRY_ROWS,
  WATERFALL_DRY_MAX_ROWS, WATERFALL_DRY_WAIT_SECONDS, FORMULA_MAX_CHARS,
} from '../lib/constants';
import { MAX_SELECTED_ROWS } from '../lib/enrich-run-input';
import { RESULT_TYPES } from '../lib/waterfall/result-type';
import { TEMPLATE_IDS } from '../lib/waterfall/templates';
import { tokenWaterfall } from '../services/waterfall-token-run';
import { DAILY_LIMIT_NOTE, STATUS_WORDS } from '../services/enrich-agent-shared';
import { runIfSchema } from './run-if-schema';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

const money = () => z.number().positive();
const common = {
  id: z.string().max(20).optional().describe('Keep a step\'s id (from action describe) to keep its column'),
  label: z.string().max(WATERFALL_LABEL_MAX_CHARS).optional()
    .describe('What "answered by" shows; default the tool\'s name, "AI" or the API\'s host'),
  on: lenientBoolean().optional().describe('false keeps the step but skips it'),
  requires: z.array(z.array(z.string()).min(1)).max(WATERFALL_MAX_ALTERNATIVES).optional()
    .describe('Alternatives of input keys, e.g. [["full_name","domain"],["linkedin_url"]]; a row with none skips it'),
  check: z.union([
    z.object({ kind: z.literal('verify'), accept: z.enum(['safest', 'balanced', 'wide']).optional() }).strict(),
    z.object({ kind: z.literal('formula'), formula: z.string().max(FORMULA_MAX_CHARS) }).strict(),
  ]).optional().describe('Checks a value the step finds; a value that fails is rejected and the next step runs'),
};
const step = z.discriminatedUnion('kind', [
  z.object({
    ...common, kind: z.literal('enrichment'), tool_id: z.string().max(200),
    inputs: z.record(z.string(), z.union([z.string(), z.object({ value: z.string() }).strict()])).optional()
      .describe('Tool input -> input key (default: the same names), or {"value": fixed}'),
    value_path: z.string().max(500).optional().describe('Answer field, e.g. $.output.email (default: by result_type)'),
    provider_order: z.array(z.string()).max(100).optional(),
    skip_providers: z.array(z.string()).max(100).optional(),
    stop_at_first: lenientBoolean().optional(),
    max_cost_usd: money().optional().describe('This step\'s cap a row (default: what its providers can cost)'),
  }).strict(),
  z.object({
    ...common, kind: z.literal('ai'), prompt: z.string().max(WATERFALL_PROMPT_MAX_CHARS)
      .describe('Uses /input_key words, e.g. "Find the work email of /full_name at /domain"'),
    model: z.string().max(200).optional().describe('Default: the sheet\'s, else the account\'s default model'),
    web_search: lenientBoolean().optional(),
  }).strict(),
  z.object({
    ...common, kind: z.literal('http'), method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(),
    url: z.string().max(2_000).describe('{{input_key}} and saved keys (/key_name) are filled per row'),
    headers: z.record(z.string(), z.string()).optional(), body: z.string().max(20_000).optional(),
    value_path: z.string().max(500).describe('JSONPath of the value in the JSON response, e.g. $.email'),
    retries: z.number().int().min(0).max(HTTP_RETRY_MAX).optional(),
  }).strict(),
  z.object({
    ...common, kind: z.literal('formula'), formula: z.string().max(FORMULA_MAX_CHARS)
      .describe('JavaScript over {{input_key}}, e.g. {{first_name}}.toLowerCase() + "@" + {{domain}}'),
  }).strict(),
  z.object({
    ...common, kind: z.literal('lookup'), other_sheet_id: z.string().max(200).describe('Another sheet (list_tables)'),
    match_column: z.string().max(200).describe('Its column matched against the input'),
    match: z.enum(['equals', 'contains']).optional().describe('Default equals (case and spaces aside)'),
    input: z.string().max(40).describe('The input key whose value it looks for, e.g. domain'),
    return_column: z.string().max(200).describe('Its column whose value, in the first matching row, is the answer'),
  }).strict(),
]);

export const WATERFALL_DESCRIPTION =
  'Fill ONE value per row (a work email, phone, company domain, LinkedIn URL, URL or any text) by trying ordered '
  + 'steps and stopping at the first answer: a waterfall column. A step is an enrichment (a treg.to tool from '
  + 'search_enrichments), an ai prompt, an http call to your own JSON API, a free formula (JavaScript over '
  + '{{input_key}}, run in a sandbox), or a free lookup in another sheet of the account (return_column of the '
  + 'first row, top first, whose match_column equals or contains the input; put it first to skip paid steps for '
  + 'rows you already have; a rename there follows, a deleted sheet or column pauses the run). '
  + 'A step\'s check tests the value it finds before it counts: '
  + '{"kind":"verify","accept":"safest"|"balanced"|"wide"} (treg\'s email verify, paid, email only) or '
  + '{"kind":"formula","formula":"..."} over {{value}} and the inputs (truthy passes); a value that fails is '
  + 'rejected and the next step runs. '
  + 'inputs maps each input key ONCE to a column ({"full_name": "Name", "domain": "Website"}) or {"value": fixed}; '
  + 'every step reads these keys, never columns (treg tools take them by name: first_name, last_name, full_name, '
  + 'domain, company, linkedin_url, email). result_type decides what counts as an answer: a value it can\'t read '
  + '(not an email, "not found") is no answer, and the next step runs. A step\'s requires lists alternatives of '
  + 'input keys; a row with none of them skips that step for free (an enrichment step also follows its tool\'s own '
  + 'identity rule). on:false keeps a step but skips it. A step that errors doesn\'t stop the waterfall; the row '
  + 'shows ❌ only when no step answered. '
  + 'Cells: column_name holds the answer (or "⏭️ Not found", or "❌ <step>: <why>"); '
  + 'answered_by_column (default true) '
  + 'adds "<column> (Answered by)" naming the step; each step gets "<column> (<label>)" with its own value or '
  + 'marker, hidden in the sheet\'s views by default (hide_step_columns:false shows them). '
  + 'COSTS MONEY: enrichment steps bill the treg balance, ai steps OpenRouter (http steps cost whatever your API '
  + 'charges). estimate_only DEFAULTS TO TRUE here: you get per_row {average_usd, max_usd}, the totals for the rows '
  + 'in scope and per step its reach, cost and answer rate (this column\'s earlier runs, else treg\'s observed '
  + 'rate; unknown counts as never answering, so the average errs high). Nothing is created: tell the user, then '
  + 'call again with estimate_only:false. A treg answer any run found in the last days set in Settings is reused at '
  + '$0 (fresh:true calls every step again). spend_limit_usd caps the run (treg and AI; default rows x max per '
  + `row). ${DAILY_LIMIT_NOTE} `
  + 'TEMPLATES: template "work_email" (treg\'s email finder, then a first.last@domain guess that counts only '
  + 'when treg\'s email verify says it\'s valid) or "mobile_phone" (treg\'s phone finder: a mobile or direct '
  + 'number) gives result_type and '
  + 'steps for a new column; you still map inputs (its other input keys stay unmapped), and steps you pass replace '
  + 'its own. '
  + 'Rows: all by default; add_to_column:true runs an existing waterfall column again (its own inputs and steps '
  + 'unless you pass new ones; a step keeps its column by id or label) on rows not_enriched (default), no_result, '
  + 'failed, out_of_date (results whose input cells changed since), empty_or_out_of_date or any; '
  + `test:true runs the first ${ENRICH_TEST_ROWS} rows; use_sheet_filter, target_row_ids, run_if. `
  + `DRY RUN: dry_run:true runs the first ${WATERFALL_DRY_ROWS} rows the run would take (or target_row_ids, up to `
  + `${WATERFALL_DRY_MAX_ROWS}) for real and writes nothing to the sheet; it waits up to `
  + `${WATERFALL_DRY_WAIT_SECONDS} s and returns each row's inputs and every step it reached (outcome, value, cost). `
  + 'What it bought is replayed at $0 by a real run for 7 days. test_step (a step\'s label or id) with dry_run tests '
  + 'that step alone. '
  + `concurrency: rows at once (default ${ENRICH_DEFAULT_CONCURRENCY}). auto_run {enabled, daily_cap_usd (a waterfall `
  + 'with a paid step) or daily_row_cap} keeps it filling new rows. action "describe" (read scope) returns a '
  + 'column\'s setup in this same shape, step ids included, to change and send back with add_to_column '
  + '(without the secrets scope, HTTP steps show keys, header values and bodies as "…": sent back with '
  + 'the same id and URL they keep their stored values). '
  + 'Returns run_id: poll get_run_status (run_type "waterfall": per step reached, answered, failed, cost); '
  + 'get_run_results gives each row\'s answered_by and trace. '
  + `${STATUS_WORDS} idempotency_key: retrying with the same key and arguments returns the original run_id.`;

export function registerWaterfallTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'waterfall_column', {
    description: WATERFALL_DESCRIPTION,
    // Strict at every level: a misspelled argument is refused, never dropped.
    inputSchema: z.object({
      action: z.enum(['run', 'describe']).optional().describe('Default run. describe: read a column\'s setup'),
      sheet_id: z.string(),
      column_name: z.string().max(200).describe('The result column (new, or an existing one with add_to_column)'),
      add_to_column: lenientBoolean().optional().describe('Run an existing waterfall column again'),
      result_type: z.enum(RESULT_TYPES).optional()
        .describe('What it finds (required for a new column, unless a template gives it)'),
      template: z.enum(TEMPLATE_IDS).optional()
        .describe('A starter waterfall for a new column: its result_type and steps; you map inputs'),
      phone: z.object({
        format: z.enum(['national', 'international', 'e164']).optional(), country: z.string().max(2).optional(),
      }).strict().optional().describe('result_type phone: how numbers are written; country for numbers without one'),
      inputs: z.record(z.string(), z.union([
        z.string(), z.object({ column: z.string() }).strict(), z.object({ value: z.string() }).strict(), z.null(),
      ])).optional().describe('Input key -> column name, {"column": name}, {"value": fixed} or null (unmapped)'),
      steps: z.array(step).min(1).max(WATERFALL_MAX_STEPS).optional().describe('In order; the first answer wins'),
      answered_by_column: lenientBoolean().optional(),
      hide_step_columns: lenientBoolean().optional(),
      rows: z.enum(['any', 'not_enriched', 'no_result', 'failed', 'out_of_date', 'empty_or_out_of_date']).optional()
        .describe('With add_to_column: which of its rows (default not_enriched)'),
      test: z.union([lenientBoolean(), z.number().int().min(1).max(1_000)]).optional()
        .describe(`true: the first ${ENRICH_TEST_ROWS} rows; or a number of rows`),
      use_sheet_filter: lenientBoolean().optional(),
      target_row_ids: z.array(z.string()).min(1).max(MAX_SELECTED_ROWS).optional(),
      run_if: runIfSchema,
      spend_limit_usd: money().optional(),
      concurrency: z.number().int().min(1).max(HTTP_MAX_CONCURRENCY).optional(),
      fresh: lenientBoolean().optional(),
      estimate_only: lenientBoolean().optional().describe('Default TRUE: price it, create nothing'),
      dry_run: lenientBoolean().optional()
        .describe(`true: ${WATERFALL_DRY_ROWS} rows (or target_row_ids) for real, nothing written; returns each trace`),
      test_step: z.string().max(200).optional().describe('With dry_run: run only this step (its label or id)'),
      idempotency_key: z.string().min(1).max(200).optional(),
      webhook_id: z.string().optional(),
      auto_run: z.object({
        enabled: lenientBoolean(), daily_cap_usd: money().optional(), daily_row_cap: z.number().int().min(1).optional(),
      }).strict().optional(),
    }).strict(),
  }, async (args: Record<string, unknown>) => {
    const denied = missingScope(ctx, args.action === 'describe' ? 'read' : 'run');
    if (denied) return denied;
    const r = await tokenWaterfall(
      { userId: ctx.userId, tokenId: ctx.tokenId, scopes: ctx.scopes }, args, { estimateDefault: true },
    );
    return 'fail' in r ? err(r.message) : ok(r.ok);
  });
}
