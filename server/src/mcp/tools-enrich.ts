// Enrichment tools (treg.to): find a tool, read its setup, run it per row.
// Thin wrappers over services/enrich-agent-tools.ts and enrich-token-run.ts,
// the same implementations GET /api/v1/enrichments and POST /api/v1/sheets/
// :id/enrichment-runs use. The scope check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  ENRICH_DEFAULT_CONCURRENCY, ENRICH_LIST_MAX_ITEMS, ENRICH_PROVIDER_RATE_RETRIES, ENRICH_PROVIDER_RATE_RETRIES_MAX,
  ENRICH_TEST_ROWS, HTTP_MAX_CONCURRENCY,
} from '../lib/constants';
import { MAX_SELECTED_ROWS } from '../lib/enrich-run-input';
import { GUESS_PATTERNS } from '../lib/enrich-email-guess';
import { agentSearchTools, agentGetTool } from '../services/enrich-agent-tools';
import { tokenStartEnrichmentRun, type TokenEnrichArgs } from '../services/enrich-token-run';
import { DAILY_LIMIT_NOTE } from '../services/enrich-agent-shared';
import { runIfSchema } from './run-if-schema';
import { saveOnlySchema } from './save-only-schema';
import { McpAuthCtx, SHEET_ID, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { capRunToolNote } from '../lib/token-spend';
import { GUIDE_POINTER } from './guides/guide';
import { ENRICH_ITEMS, ITEMS_FIELDS, misplacedArgument, runEnrichmentOnItems } from './enrich-items';

const input = z.union([
  z.string(), z.object({ column: z.string().describe('A column name') }).strict(),
  z.object({ value: z.string().describe('A fixed value') }).strict(),
]);
const money = () => z.number().positive();

// Its details are in its guide (mcp/guides/enrich.ts).
export const RUN_ENRICHMENT_DESCRIPTION =
  'Run a treg.to enrichment once per row: work emails, phones, person or company data, or lists whose results '
  + 'become rows in another sheet. For several sources in one column use waterfall_column. Find the tool with '
  + 'find_enrichments with action search, then read it with action get. '
  + 'COSTS MONEY: each row is a paid treg call on the user\'s treg balance (providers on the team\'s own keys '
  + 'bill the team). Call estimate_only:true first and tell the user the range; it creates nothing. '
  + 'max_cost_per_row_usd caps '
  + `each row and spend_limit_usd the run (it pauses there). ${DAILY_LIMIT_NOTE} `
  + 'LIST JOBS (adds_rows:true in find_enrichments) need list: run with test:true, wait for get_run (action status) to '
  + 'say '
  + 'completed, read the fields with get_list_fields, pick them with stored_answers (action add_rows), then '
  + 'control_run rerun mode "empty"; or pass list.fields. destination_auto_run lists the auto-runs the new rows '
  + 'set off there, and '
  + 'chained_auto_run this sheet\'s auto-runs that read what the run writes (HTTP ones send real requests). '
  + 'Returns run_id at once: poll get_run (action status, run_type "enrichment"). '
  + 'ITEMS: with items instead of sheet_id it runs on items without a sheet, for a script or another app, and '
  + 'estimate_only DEFAULTS TO TRUE; refused before it starts, never halfway, when it could pass max_cost_usd, '
  + 'the daily limit, the treg balance or the token\'s cap. get_run (action results, status_filter all) gives each '
  + 'item, '
  + 'row_index being its place in items.';

export function registerEnrichTools(server: McpServer, ctx: McpAuthCtx) {
  // search (search_enrichments before) and get (get_enrichment before): treg.to's catalog, free.
  registerTool(server, 'find_enrichments', {
    description:
      'treg.to\'s enrichment tools (work email, phone, person or company data, people or companies lists, web '
      + 'search), free. search: tools matching query (none: the popular jobs), each with tool_id, kind (waterfall: '
      + 'treg asks many providers in turn; single: one provider), its price, and adds_rows (its results become rows '
      + 'in another sheet); needs_own_key: the team needs its own provider key at treg. get: one tool by tool_id, '
      + 'ready for run_enrichment: its inputs, its outputs, its price and for a waterfall each provider. Next: '
      + `run_enrichment with estimate_only: true, or a waterfall_column step. ${GUIDE_POINTER}`,
    inputSchema: {
      action: z.enum(['search', 'get']).describe('search the catalog, or get one tool'),
      query: z.string().max(200).optional().describe('search: what to find, e.g. "work email" or "company size"'),
      tool_id: z.string().max(200).optional().describe('get: the tool (search lists them)'),
    },
  }, async ({ action, query, tool_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (action === 'search') {
      if (tool_id !== undefined) return err('tool_id is for get: search takes query.');
      const out = await agentSearchTools(query ?? '');
      return 'ok' in out ? ok(out.ok) : err(out.message);
    }
    if (query !== undefined) return err('query is for search: get takes tool_id.');
    if (!tool_id) return err('get needs tool_id.');
    const out = await agentGetTool(ctx.userId, tool_id);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'run_enrichment', {
    description: RUN_ENRICHMENT_DESCRIPTION + capRunToolNote(ctx.spend ?? null) + ` ${GUIDE_POINTER}`,
    // Strict: an argument it doesn't know (estimateOnly, test_rows) is refused,
    // never dropped, so a misspelled estimate can't start a paid run.
    inputSchema: z.object({
      sheet_id: z.string().optional().describe(`${SHEET_ID}; or items instead`),
      items: ENRICH_ITEMS.optional(),
      tool_id: z.string().max(200).describe('The tool (find_enrichments search lists them)'),
      column_name: z.string().max(200).optional()
        .describe('The status column (new, or an existing one with add_to_column); needed with sheet_id'),
      preset: z.enum(['verified_email']).optional()
        .describe('verified_email (the email finder only): check each address, find again until one passes'),
      add_to_column: lenientBoolean().optional().describe('Add to an enrichment column a run already made'),
      inputs: z.record(z.string(), input).optional()
        .describe('Tool input -> a column name, {"column": name} or {"value": fixed}. treg works best with every '
          + 'identity input you have.'),
      outputs: z.array(z.object({
        field: z.string().describe('A field of find_enrichments get\'s output_fields'),
        column_name: z.string().describe('The new column it fills'),
      }).strict()).optional()
        .describe('The fields that become new columns. Optional for list jobs: there they fill the asking row '
          + 'from the answer\'s fields outside its results'),
      email: z.object({
        accept: z.enum(['safest', 'balanced', 'wide']).optional()
          .describe('safest (valid only, default), balanced (+ catch-all) or wide (+ risky)'),
        guess: lenientBoolean().optional().describe('Try a free first.last@domain guess first'),
        pattern: z.enum(GUESS_PATTERNS).optional().describe('The guess\'s pattern'),
      }).strict().optional().describe('preset verified_email only'),
      provider_order: z.array(z.string()).max(100).optional()
        .describe('Waterfall tools: providers to ask first, in this order (the finds, not the checks)'),
      skip_providers: z.array(z.string()).max(100).optional()
        .describe('Waterfall tools: providers left out (of the checks too)'),
      stop_at_first: lenientBoolean().optional().describe('Waterfall tools: stop after the first answer, even empty'),
      clean_domains: lenientBoolean().optional().describe('Default true: URLs in domain inputs become bare domains'),
      fresh: lenientBoolean().optional()
        .describe('Call every row again: no reuse of earlier found answers, and providers asked, not treg\'s store'),
      max_cost_per_row_usd: money().optional()
        .describe('Dollars a row may cost (sent to treg). Default: every provider picked may answer'),
      spend_limit_usd: money().optional()
        .describe('Dollars the run may spend; it pauses there. Default: rows in scope x max per row'),
      concurrency: z.number().int().min(1).max(HTTP_MAX_CONCURRENCY).optional()
        .describe(`Rows at once (1-${HTTP_MAX_CONCURRENCY}, default ${ENRICH_DEFAULT_CONCURRENCY}). `
          + 'Reruns and auto-run keep it'),
      rate_limit_retries: z.number().int().min(0).max(ENRICH_PROVIDER_RATE_RETRIES_MAX).optional()
        .describe(`Retries on provider 429s for each row (0-${ENRICH_PROVIDER_RATE_RETRIES_MAX}, default `
          + `${ENRICH_PROVIDER_RATE_RETRIES}; a verified_email row's finds and checks share them). Reruns keep it`),
      rows: z.enum(['any', 'not_enriched', 'no_result', 'failed', 'out_of_date', 'empty_or_out_of_date']).optional()
        .describe('Which rows. out_of_date: a result whose input cells changed since. All but any and not_enriched '
          + 'need add_to_column. Default: any (not_enriched with add_to_column)'),
      use_sheet_filter: lenientBoolean().optional().describe('Only the rows the sheet\'s saved filter shows'),
      target_row_ids: z.array(z.string()).min(1).max(MAX_SELECTED_ROWS).optional()
        .describe(`Stable row ids (from read_rows) to run, up to ${MAX_SELECTED_ROWS.toLocaleString('en-US')}`),
      test: lenientBoolean().optional().describe(`Run the first ${ENRICH_TEST_ROWS} rows only`),
      where: z.array(z.object({
        column: z.string().describe('A column name'),
        operator: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt']).describe('The test'),
        value: z.string().optional().describe('What it compares with (not for empty, not_empty)'),
      }).strict()).max(20).optional().describe('Older form of run_if: only rows matching all of these'),
      run_if: runIfSchema,
      save_only: saveOnlySchema('run_enrichment'),
      list: z.object({
        destination_sheet_id: z.string().optional().describe('A sheet in the same table to add the rows to'),
        new_sheet_name: z.string().max(200).optional().describe('Or a new sheet to make for them'),
        provider: z.string().optional().describe('One provider; treg returns each provider\'s own fields'),
        results_per_row: z.number().int().min(1).max(ENRICH_LIST_MAX_ITEMS).optional()
          .describe(`Results a row adds, 1-${ENRICH_LIST_MAX_ITEMS} (the price dial)`),
        fields: z.array(z.object({
          path: z.string().describe('A field\'s path in a result (get_list_fields)'),
          column_name: z.string().describe('The destination column'),
        }).strict()).optional().describe('The result fields to keep, when you know them'),
        copy_columns: z.array(z.object({
          from: z.string().optional().describe('A column of the asking row to copy'),
          to: z.string().optional().describe('The destination column'),
          value: z.string().optional().describe('Or the same text in every added row'),
        }).strict()).optional().describe('Columns each added row gets: [{from, to}] or [{to, value}]'),
        dedupe_path: z.string().optional().describe('Skip a result whose value here was added before'),
        items_path: z.string().max(500).optional()
          .describe('A single tool only: add the rows from another list of its answer '
            + '(find_enrichments get\'s other_lists)'),
      }).strict().optional().describe('List jobs only: where the results go as rows'),
      auto_run: z.object({
        enabled: lenientBoolean().describe('true keeps the column filling'),
        daily_cap_usd: money().optional().describe('Dollars it may spend a UTC day'),
      }).strict().optional()
        .describe('Keep filling new rows (and rows whose inputs get filled) after this run, once a row; rows '
          + 'already in the sheet are not touched'),
      estimate_only: lenientBoolean().optional()
        .describe('Price it and create nothing (default false on a sheet, true with items)'),
      idempotency_key: z.string().min(1).max(200).optional()
        .describe('A retry with the same key and arguments returns the first run_id'),
      webhook_id: z.string().optional()
        .describe('A run webhook (list_run_webhooks) to notify when the run finishes; poll get_run (action status) '
          + 'anyway'),
      ...ITEMS_FIELDS,
    }).strict(),
  }, async args => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const misplaced = misplacedArgument(args);
    if (misplaced) return err(misplaced);
    if (args.items) return runEnrichmentOnItems(ctx, { ...args, items: args.items });
    const r = await tokenStartEnrichmentRun(ctx, args as TokenEnrichArgs);
    if ('fail' in r) return err(r.message);
    return ok({ ...r.ok, changed: r.changed ?? [] });
  });
}
