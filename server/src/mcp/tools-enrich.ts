// Enrichment tools (treg.to): find a tool, read its setup, run it per row.
// Thin wrappers over services/enrich-agent-tools.ts and enrich-token-run.ts,
// the same implementations GET /api/v1/enrichments and POST /api/v1/sheets/
// :id/enrichment-runs use. The scope check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  ENRICH_DEFAULT_CONCURRENCY, ENRICH_LIST_MAX_ITEMS, ENRICH_TEST_ROWS, HTTP_MAX_CONCURRENCY,
} from '../lib/constants';
import { MAX_SELECTED_ROWS } from '../lib/enrich-run-input';
import { GUESS_PATTERNS } from '../lib/enrich-email-guess';
import { agentSearchTools, agentGetTool } from '../services/enrich-agent-tools';
import { tokenStartEnrichmentRun, type TokenEnrichArgs } from '../services/enrich-token-run';
import { DAILY_LIMIT_NOTE } from '../services/enrich-agent-shared';
import { runIfSchema } from './run-if-schema';
import { McpAuthCtx, SHEET_ID, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { capToolNote } from '../lib/token-spend';

const input = z.union([
  z.string(), z.object({ column: z.string().describe('A column name') }).strict(),
  z.object({ value: z.string().describe('A fixed value') }).strict(),
]);
const money = () => z.number().positive();

export const RUN_ENRICHMENT_DESCRIPTION =
  'Run a treg.to enrichment once per row: work emails (verified), phones, person or company data, or lists '
  + '(people at a company, similar companies) whose results become rows in another sheet. For one lookup use '
  + 'this; to try several sources in turn (treg tools, AI, HTTP) in one column use waterfall_column. First find '
  + 'the tool with search_enrichments and read its inputs, outputs and providers with get_enrichment. '
  + 'COSTS MONEY: each row is a paid treg call on the user\'s treg balance (providers on the team\'s own keys '
  + 'bill the team). Call estimate_only:true first and tell the user the range; it creates nothing. A row whose '
  + 'exact lookup (same tool, inputs and provider choices) found something in this account within the days set '
  + 'in Settings (30 by default, 0 turns it off) reuses that answer at $0; the estimate counts those rows (reuse) '
  + 'and prices the rest. max_cost_per_row_usd caps each row and spend_limit_usd the run (it pauses there). '
  + `${DAILY_LIMIT_NOTE} `
  + 'Speed: concurrency is the lever (a waterfall row can take seconds). A row whose providers all answered 429 '
  + 'waits and asks again for free, up to 5 times over a few minutes, then fails; lower concurrency for a '
  + 'provider that keeps answering 429 (ContactOut\'s free email check on treg\'s own key takes about 20 calls '
  + 'a minute for all of treg). Each running row holds max_cost_per_row_usd against the daily and run '
  + 'limits, so those also cap how many run at once. '
  + 'Waterfall tools ask providers in turn until one finds it. preset verified_email (the email finder only) '
  + 'checks each address and finds again with other providers until one passes email.accept. '
  + 'LIST JOBS (get_enrichment adds_rows:true) need list. The fields to keep come from real results: run with '
  + 'test:true, poll get_run_status until it completes (enrichment.list.waiting_for_fields counts them), read '
  + 'them with get_list_fields, pick them with add_list_rows (adds those rows), then control_run rerun mode '
  + '"empty" runs the rest. Or pass list.fields when you know them. destination_auto_run lists what the new rows '
  + 'set off in the destination; chained_auto_run lists this sheet\'s auto-runs that read what the run writes '
  + '(they fill those rows after it; HTTP ones send real requests). '
  + 'Returns run_id at once: poll get_run_status (run_type "enrichment"); cells show "⏳ Processing..." meanwhile '
  + 'and then Cubex\'s status words (get_run_status lists them).';

export function registerEnrichTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'search_enrichments', {
    description:
      'Search treg.to\'s catalog of enrichment tools (work email, phone, person or company data, people or '
      + 'companies lists, web search). No query: the popular jobs. Each tool has tool_id, kind (waterfall: treg asks '
      + 'many providers in turn; single: one provider), its price, and adds_rows (its results become rows in '
      + 'another sheet). needs_own_key: treg can\'t serve it on its own key, the team needs its own provider key at '
      + 'treg. Next: get_enrichment for its inputs and outputs, then run_enrichment (or a waterfall_column step).',
    inputSchema: {
      query: z.string().max(200).optional().describe('What to find, e.g. "work email" or "company size"'),
    },
  }, async ({ query }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = await agentSearchTools(query ?? '');
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'get_enrichment', {
    description:
      'One enrichment tool, ready for run_enrichment: its inputs (name, type, required; identity_sets lists the '
      + 'inputs that are enough together; filter inputs narrow a search), its outputs (field names for '
      + 'run_enrichment outputs; for a tool that adds rows, only the fields outside its results, which fill the '
      + 'asking row; the results\' own fields come from real results), its price, '
      + 'and for a waterfall each provider (price, hit rate, the inputs it accepts, and with a treg key saved, '
      + 'access as treg\'s plan says: your_key (the team\'s own key), your_connection_metered, free, treg (treg\'s '
      + 'key), or null when the plan doesn\'t say). The email finder also offers the verified_email preset. '
      + 'Free. Next: run_enrichment with estimate_only:true.',
    inputSchema: { tool_id: z.string().max(200).describe('The tool (search_enrichments lists them)') },
  }, async ({ tool_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = await agentGetTool(ctx.userId, tool_id);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'run_enrichment', {
    description: RUN_ENRICHMENT_DESCRIPTION + capToolNote(ctx.spend ?? null, true),
    // Strict: an argument it doesn't know (estimateOnly, test_rows) is refused,
    // never dropped, so a misspelled estimate can't start a paid run.
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      tool_id: z.string().max(200).describe('The tool (search_enrichments lists them)'),
      column_name: z.string().max(200).describe('The status column (new, or an existing one with add_to_column)'),
      preset: z.enum(['verified_email']).optional()
        .describe('verified_email (the email finder only): check each address, find again until one passes'),
      add_to_column: lenientBoolean().optional().describe('Add to an enrichment column a run already made'),
      inputs: z.record(z.string(), input).optional()
        .describe('Tool input -> a column name, {"column": name} or {"value": fixed}, e.g. {"domain": "Website", '
          + '"country": {"value": "US"}}. treg works best with every identity input you have.'),
      outputs: z.array(z.object({
        field: z.string().describe('A field from get_enrichment output_fields'),
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
          .describe('A single tool only: add the rows from another list of its answer, one get_enrichment '
            + 'lists in other_lists (often shown empty in its example)'),
      }).strict().optional().describe('List jobs only: where the results go as rows'),
      auto_run: z.object({
        enabled: lenientBoolean().describe('true keeps the column filling'),
        daily_cap_usd: money().optional().describe('Dollars it may spend a UTC day'),
      }).strict().optional()
        .describe('Keep filling new rows (and rows whose inputs get filled) after this run, once a row; rows '
          + 'already in the sheet are not touched'),
      estimate_only: lenientBoolean().optional().describe('Price it and create nothing (default false)'),
      idempotency_key: z.string().min(1).max(200).optional()
        .describe('A retry with the same key and arguments returns the first run_id'),
      webhook_id: z.string().optional()
        .describe('A run webhook (list_run_webhooks) to notify when the run finishes; poll get_run_status anyway'),
    }).strict(),
  }, async (args: TokenEnrichArgs) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const r = await tokenStartEnrichmentRun(ctx, args);
    if ('fail' in r) return err(r.message);
    return ok({ ...r.ok, changed: r.changed ?? [] });
  });
}
