// waterfall_column: one value per row from ordered steps, stopping at the
// first answer. A thin wrapper over services/waterfall-token-run.ts, the same
// implementation POST /api/v1/sheets/:id/waterfall-columns uses. The scope
// check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  ENRICH_DEFAULT_CONCURRENCY, ENRICH_TEST_ROWS, HTTP_MAX_CONCURRENCY, HTTP_RETRY_MAX, WATERFALL_LABEL_MAX_CHARS,
  WATERFALL_MAX_ALTERNATIVES, WATERFALL_MAX_STEPS, WATERFALL_PROMPT_MAX_CHARS, WATERFALL_DRY_ROWS,
  WATERFALL_DRY_MAX_ROWS, WATERFALL_DRY_WAIT_SECONDS, FORMULA_MAX_CHARS,
} from '../lib/constants';
import { MAX_SELECTED_ROWS } from '../lib/enrich-run-input';
import { RESULT_TYPES } from '../lib/waterfall/result-type';
import { TEMPLATE_IDS } from '../lib/waterfall/templates';
import { tokenWaterfall } from '../services/waterfall-token-run';
import { DAILY_LIMIT_NOTE } from '../services/enrich-agent-shared';
import { runIfSchema } from './run-if-schema';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, SHEET_ID } from './tool-helpers';
import { capToolNote } from '../lib/token-spend';

const money = () => z.number().positive();
// Repeated in each step kind of tools/list: kept short.
const common = {
  id: z.string().max(20).optional().describe('Its id from describe: keeps its column'),
  label: z.string().max(WATERFALL_LABEL_MAX_CHARS).optional()
    .describe('Its name in "Answered by" (default the tool, "AI" or the API host)'),
  on: lenientBoolean().optional().describe('false keeps the step but skips it'),
  requires: z.array(z.array(z.string()).min(1)).max(WATERFALL_MAX_ALTERNATIVES).optional()
    .describe('Input key sets, any one enough: [["full_name","domain"],["linkedin_url"]]'),
  check: z.union([
    z.object({
      kind: z.literal('verify').describe('treg email verify'), accept: z.enum(['safest', 'balanced', 'wide']).optional()
        .describe('How sure'),
      provider_order: z.array(z.string()).max(100).optional().describe('Asked first'),
      skip_providers: z.array(z.string()).max(100).optional().describe('Never asked'),
    }).strict(),
    z.object({
      kind: z.literal('formula').describe('A formula'),
      formula: z.string().max(FORMULA_MAX_CHARS).describe('Truthy passes'),
    }).strict(),
  ]).optional().describe('Tests the value found; a fail means the next step runs'),
};
const step = z.discriminatedUnion('kind', [
  z.object({
    ...common, kind: z.literal('enrichment').describe('A treg.to tool'),
    tool_id: z.string().max(200).describe('From search_enrichments'),
    inputs: z.record(z.string(), z.union([
      z.string(), z.object({ value: z.string().describe('A fixed value') }).strict(),
    ]))
      .optional().describe('Tool input -> input key (default: the same names), or {"value": fixed}'),
    value_path: z.string().max(500).optional().describe('Answer field, e.g. $.output.email (default: by result_type)'),
    provider_order: z.array(z.string()).max(100).optional().describe('Providers asked first, in this order'),
    skip_providers: z.array(z.string()).max(100).optional().describe('Providers never asked'),
    stop_at_first: lenientBoolean().optional().describe('Stop after the first answer, even an empty one'),
    max_cost_usd: money().optional().describe('This step\'s cap a row (default: what its providers can cost)'),
  }).strict(),
  z.object({
    ...common, kind: z.literal('ai').describe('An AI prompt'), prompt: z.string().max(WATERFALL_PROMPT_MAX_CHARS)
      .describe('Uses /input_key words, e.g. "Find the work email of /full_name at /domain"'),
    model: z.string().max(200).optional().describe('Default: the sheet\'s, else the account\'s default model'),
    web_search: lenientBoolean().optional().describe('Let the model search the web'),
  }).strict(),
  z.object({
    ...common, kind: z.literal('http').describe('Your JSON API'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('Default GET'),
    url: z.string().max(2_000).describe('{{input_key}} and saved keys (/key_name) are filled per row'),
    headers: z.record(z.string(), z.string()).optional().describe('Header -> value, filled per row'),
    body: z.string().max(20_000).optional().describe('Request body, filled per row'),
    value_path: z.string().max(500).describe('JSONPath of the value in the JSON response, e.g. $.email'),
    retries: z.number().int().min(0).max(HTTP_RETRY_MAX).optional().describe(`Retries, 0-${HTTP_RETRY_MAX}`),
  }).strict(),
  z.object({
    ...common, kind: z.literal('formula').describe('A free formula'), formula: z.string().max(FORMULA_MAX_CHARS)
      .describe('JavaScript over {{input_key}}, e.g. {{first_name}}.toLowerCase() + "@" + {{domain}}'),
  }).strict(),
  z.object({
    ...common, kind: z.literal('lookup').describe('A free lookup'),
    other_sheet_id: z.string().max(200).describe('Another sheet (list_tables)'),
    match_column: z.string().max(200).describe('Its column matched against the input'),
    match: z.enum(['equals', 'contains']).optional().describe('Default equals (case and spaces aside)'),
    input: z.string().max(40).describe('The input key whose value it looks for, e.g. domain'),
    return_column: z.string().max(200).describe('Its column whose value, in the first matching row, is the answer'),
  }).strict(),
]);

export const WATERFALL_DESCRIPTION =
  'Fill ONE value per row (a work email, phone, company domain, LinkedIn URL or any text) by trying ordered steps '
  + 'and stopping at the first answer. For one source only, run_enrichment or run_ai_column is simpler. Steps: '
  + 'enrichment (a treg.to tool from search_enrichments), ai (a prompt), http (your JSON API), formula (free '
  + 'JavaScript over {{input_key}}, sandboxed) or lookup (free: return_column of the first row of another sheet '
  + 'whose match_column equals or contains the input; put it first to skip paid steps for rows you already have; '
  + 'a rename there follows, a deleted sheet or column pauses the run). '
  + 'inputs maps each input key ONCE to a column ({"full_name": "Name", "domain": "Website"}) or {"value": fixed}; '
  + 'steps read keys, never columns (treg tools take them by name: first_name, last_name, full_name, domain, '
  + 'company, linkedin_url, email). result_type decides what counts as an answer: a value it can\'t read (not an '
  + 'email, "not found") is none, and the next step runs. A step\'s requires lists sets of input keys; a row with '
  + 'none of them skips it for free. A step\'s check tests the value before it counts: verify (treg\'s email '
  + 'verify, paid; get_enrichment treg.people.email.verify lists its providers) or a formula over {{value}} and the '
  + 'inputs. A step that errors doesn\'t stop the waterfall; the row shows ❌ only when no step answered. '
  + 'Cells: column_name holds the answer (or "⏭️ Not found", or "❌ <step>: <why>"); "<column> (Answered by)" names '
  + 'the step (answered_by_column); each step gets "<column> (<label>)", hidden in views unless hide_step_columns '
  + 'is false. '
  + 'COSTS MONEY: enrichment steps bill the treg balance, ai steps OpenRouter. estimate_only DEFAULTS TO TRUE: '
  + 'per_row {average_usd, max_usd}, totals and per step its reach, cost and answer rate (unknown counts as never '
  + 'answering, so it errs high), and nothing is created: tell the user, then call again with estimate_only '
  + 'false. A treg answer found in the days set in Settings is reused at $0 (fresh true calls again). '
  + `spend_limit_usd caps the run. ${DAILY_LIMIT_NOTE} `
  + 'TEMPLATES: "work_email" (treg\'s finder, then a first.last@domain guess that counts only when verify says '
  + 'valid) or "mobile_phone" give result_type and steps; you still map inputs, and steps you pass replace its '
  + 'own. '
  + 'ROWS: all by default; add_to_column runs an existing waterfall column again (its own setup unless you pass '
  + 'new parts) on rows not_enriched (default), no_result, failed, out_of_date, empty_or_out_of_date or any; '
  + `test true: the first ${ENRICH_TEST_ROWS}; also use_sheet_filter, target_row_ids, run_if. `
  + `DRY RUN: dry_run runs ${WATERFALL_DRY_ROWS} rows (or target_row_ids, up to ${WATERFALL_DRY_MAX_ROWS}) for real, `
  + `writes nothing, waits up to ${WATERFALL_DRY_WAIT_SECONDS} s and returns each row\'s inputs and steps reached `
  + '(outcome, value, cost); a real run replays what it bought at $0 for 7 days. test_step tests one step. '
  + 'auto_run keeps it filling new rows. action "describe" (read scope) returns a column\'s setup in this same '
  + 'shape, step ids included, to change and send back with add_to_column (without the secrets scope HTTP keys '
  + 'read "…": sent back with the same id and URL they keep their stored values). '
  + 'Returns run_id: poll get_run_status (run_type waterfall), then get_run_results for each row\'s answered_by '
  + 'and trace. Status cells use Cubex\'s own words (get_run_status lists them).';

export function registerWaterfallTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'waterfall_column', {
    description: WATERFALL_DESCRIPTION + capToolNote(ctx.spend ?? null, true),
    // Strict at every level: a misspelled argument is refused, never dropped.
    inputSchema: z.object({
      action: z.enum(['run', 'describe']).optional().describe('Default run. describe: read a column\'s setup'),
      sheet_id: z.string().describe(SHEET_ID),
      column_name: z.string().max(200).describe('The result column (new, or an existing one with add_to_column)'),
      add_to_column: lenientBoolean().optional().describe('Run an existing waterfall column again'),
      result_type: z.enum(RESULT_TYPES).optional()
        .describe('What it finds (required for a new column, unless a template gives it)'),
      template: z.enum(TEMPLATE_IDS).optional()
        .describe('A starter waterfall for a new column: its result_type and steps; you map inputs'),
      phone: z.object({
        format: z.enum(['national', 'international', 'e164']).optional().describe('How numbers are written'),
        country: z.string().max(2).optional().describe('Two letters, e.g. US: for numbers without a country code'),
      }).strict().optional().describe('result_type phone: how numbers are written; country for numbers without one'),
      inputs: z.record(z.string(), z.union([
        z.string(), z.object({ column: z.string().describe('A column') }).strict(),
        z.object({ value: z.string().describe('A fixed value') }).strict(), z.null(),
      ])).optional().describe('Input key -> column name, {"column": name}, {"value": fixed} or null (unmapped)'),
      steps: z.array(step).min(1).max(WATERFALL_MAX_STEPS).optional().describe('In order; the first answer wins'),
      answered_by_column: lenientBoolean().optional().describe('Add "<column> (Answered by)". Default true'),
      hide_step_columns: lenientBoolean().optional().describe('Hide the step columns in views. Default true'),
      rows: z.enum(['any', 'not_enriched', 'no_result', 'failed', 'out_of_date', 'empty_or_out_of_date']).optional()
        .describe('With add_to_column: which of its rows (default not_enriched)'),
      test: z.union([lenientBoolean(), z.number().int().min(1).max(1_000)]).optional()
        .describe(`true: the first ${ENRICH_TEST_ROWS} rows; or a number of rows`),
      use_sheet_filter: lenientBoolean().optional().describe('Only the rows the sheet\'s filter shows'),
      target_row_ids: z.array(z.string()).min(1).max(MAX_SELECTED_ROWS).optional().describe('Only these rows'),
      run_if: runIfSchema,
      spend_limit_usd: money().optional().describe('The run\'s cap in dollars (default rows x the most a row costs)'),
      concurrency: z.number().int().min(1).max(HTTP_MAX_CONCURRENCY).optional()
        .describe(`Rows at once, 1-${HTTP_MAX_CONCURRENCY} (default ${ENRICH_DEFAULT_CONCURRENCY})`),
      fresh: lenientBoolean().optional().describe('true: call every step again instead of reusing answers'),
      estimate_only: lenientBoolean().optional().describe('Default TRUE: price it, create nothing'),
      dry_run: lenientBoolean().optional()
        .describe(`true: ${WATERFALL_DRY_ROWS} rows (or target_row_ids) for real, nothing written; returns each trace`),
      test_step: z.string().max(200).optional().describe('With dry_run: run only this step (its label or id)'),
      idempotency_key: z.string().min(1).max(200).optional()
        .describe('A retry with the same key returns the first run'),
      webhook_id: z.string().optional().describe('A run webhook to notify when it finishes (list_run_webhooks)'),
      auto_run: z.object({
        enabled: lenientBoolean().describe('true keeps it filling new rows'),
        daily_cap_usd: money().optional().describe('With a paid step: dollars a day'),
        daily_row_cap: z.number().int().min(1).optional().describe('Without one: rows a day'),
      }).strict().optional().describe('Keep the column filling new rows'),
    }).strict(),
  }, async (args: Record<string, unknown>) => {
    const denied = missingScope(ctx, args.action === 'describe' ? 'read' : 'run');
    if (denied) return denied;
    const r = await tokenWaterfall(
      { userId: ctx.userId, tokenId: ctx.tokenId, scopes: ctx.scopes }, args, { estimateDefault: true },
    );
    if ('fail' in r) return err(r.message);
    // Only a start has changed (a dry run writes nothing into the sheet).
    return ok({ ...r.ok, changed: r.changed ?? [] });
  });
}
