// Enrichment tools (treg.to): find a tool, read its setup, run it per row.
// Thin wrappers over services/enrich-agent-tools.ts and enrich-token-run.ts,
// the same implementations GET /api/v1/enrichments and POST /api/v1/sheets/
// :id/enrichment-runs use. The scope check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ENRICH_LIST_MAX_ITEMS, ENRICH_TEST_ROWS } from '../lib/constants';
import { MAX_SELECTED_ROWS } from '../lib/enrich-run-input';
import { GUESS_PATTERNS } from '../lib/enrich-email-guess';
import { agentSearchTools, agentGetTool } from '../services/enrich-agent-tools';
import { tokenStartEnrichmentRun, type TokenEnrichArgs } from '../services/enrich-token-run';
import { DAILY_LIMIT_NOTE, STATUS_WORDS } from '../services/enrich-agent-shared';
import { runIfSchema } from './run-if-schema';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

const condition = z.object({
  column: z.string(),
  operator: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt']),
  value: z.string().optional(),
}).strict();
const input = z.union([
  z.string(), z.object({ column: z.string() }).strict(), z.object({ value: z.string() }).strict(),
]);
const money = () => z.number().positive();

export const RUN_ENRICHMENT_DESCRIPTION =
  'Run a treg.to enrichment once per row: work emails (verified), phones, person or company data, or lists '
  + '(people at a company, similar companies) that become rows in another sheet. Find the tool with '
  + 'search_enrichments and read its inputs, outputs and providers with get_enrichment first. '
  + 'inputs maps each tool input to a column ({"domain": "Website"}) or a fixed value ({"country": {"value": "US"}}); '
  + 'treg works best with every identity input you have. outputs [{field, column_name}] picks the fields that '
  + 'become new columns; column_name names the status column. '
  + `COSTS MONEY: each row is a paid treg call on the user's treg balance (providers on the team's own keys bill `
  + 'the team directly). Call estimate_only:true first and tell the user the range; it creates nothing. '
  + `test:true runs the first ${ENRICH_TEST_ROWS} rows only. max_cost_per_row_usd caps each row (sent to treg; the `
  + 'default lets every provider picked answer) and spend_limit_usd caps the run (it pauses there; default: rows in '
  + `scope x max per row). ${DAILY_LIMIT_NOTE} `
  + 'Waterfall tools ask providers in turn until one finds it: provider_order puts some first, skip_providers '
  + 'leaves some out, stop_at_first stops after the first answer even if empty. preset verified_email (the email '
  + 'finder only) checks each address and finds again with other providers until one passes email.accept: '
  + 'safest (valid only, default), balanced (+ catch-all) or wide (+ risky); email.guess tries a free '
  + 'first.last@domain guess first. Which rows: all by default; rows not_enriched / no_result / failed on a '
  + 'column a run made (add_to_column:true adds to an existing enrichment column), use_sheet_filter, '
  + 'target_row_ids, and run_if (only rows passing a rule; the others show "⏭️ Condition not met" and cost '
  + 'nothing; the older where list still works). '
  + 'LIST JOBS (get_enrichment adds_rows:true): pass list {new_sheet_name or destination_sheet_id (same table), '
  + 'provider (one provider: treg returns each provider\'s own fields), results_per_row (the price dial), '
  + 'copy_columns}; no outputs. The fields to keep come from real results: run with test:true, poll '
  + 'get_run_status until the run completes (its enrichment.list.waiting_for_fields counts them), read the fields '
  + 'with get_list_fields, pick them with add_list_rows (adds those rows), then control_run rerun mode "empty" runs '
  + 'the rest. Or pass list.fields when you already know them. When auto-run is on in the destination, '
  + 'destination_auto_run lists what the new rows set off there. chained_auto_run lists the auto-runs in this '
  + 'sheet that read what the run writes: they fill those rows after it (HTTP ones send real requests). '
  + 'auto_run {enabled:true, daily_cap_usd} keeps the column filling new rows (and rows whose inputs get filled) '
  + 'after this run, at most once a row; rows already in the sheet are not touched. '
  + 'Returns run_id at once: poll get_run_status (run_type "enrichment"); cells show "⏳ Processing..." meanwhile. '
  + `${STATUS_WORDS} idempotency_key: retrying with the same key and arguments returns the original run_id.`;

export function registerEnrichTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'search_enrichments', {
    description:
      'Search treg.to\'s catalog of enrichment tools (work email, phone, person or company data, people or '
      + 'companies lists, web search). No query: the popular jobs. Each tool has tool_id, kind (waterfall: treg asks '
      + 'many providers in turn; single: one provider), its price, and adds_rows (its results become rows in '
      + 'another sheet). needs_own_key: treg can\'t serve it on its own key, the team needs its own provider key at '
      + 'treg. Then get_enrichment for its inputs and outputs, and run_enrichment.',
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
      + 'run_enrichment outputs; empty for a tool that adds rows, whose fields come from real results), its price, '
      + 'and for a waterfall each provider (price, hit rate, the inputs it accepts, and with a treg key saved, '
      + 'access as treg\'s plan says: your_key (the team\'s own key), your_connection_metered, free, treg (treg\'s '
      + 'key), or null when the plan doesn\'t say). The email finder also offers the verified_email preset.',
    inputSchema: { tool_id: z.string().max(200) },
  }, async ({ tool_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = await agentGetTool(ctx.userId, tool_id);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'run_enrichment', {
    description: RUN_ENRICHMENT_DESCRIPTION,
    // Strict: an argument it doesn't know (estimateOnly, test_rows) is refused,
    // never dropped, so a misspelled estimate can't start a paid run.
    inputSchema: z.object({
      sheet_id: z.string(),
      tool_id: z.string().max(200),
      column_name: z.string().max(200).describe('The status column (new, or an existing one with add_to_column)'),
      preset: z.enum(['verified_email']).optional(),
      add_to_column: lenientBoolean().optional().describe('Add to an enrichment column a run already made'),
      inputs: z.record(z.string(), input).optional()
        .describe('Tool input -> column name, {"column": name} or {"value": fixed}'),
      outputs: z.array(z.object({ field: z.string(), column_name: z.string() }).strict()).optional()
        .describe('Fields from get_enrichment output_fields, each a new column. Not for list jobs.'),
      email: z.object({
        accept: z.enum(['safest', 'balanced', 'wide']).optional(), guess: lenientBoolean().optional(),
        pattern: z.enum(GUESS_PATTERNS).optional(),
      }).strict().optional().describe('preset verified_email only'),
      provider_order: z.array(z.string()).max(100).optional(),
      skip_providers: z.array(z.string()).max(100).optional(),
      stop_at_first: lenientBoolean().optional(),
      clean_domains: lenientBoolean().optional().describe('Default true: URLs in domain inputs become bare domains'),
      fresh: lenientBoolean().optional().describe('Ask providers for fresh data, not treg\'s stored answers'),
      max_cost_per_row_usd: money().optional(),
      spend_limit_usd: money().optional(),
      rows: z.enum(['any', 'not_enriched', 'no_result', 'failed']).optional()
        .describe('no_result and failed need add_to_column. Default: any (not_enriched with add_to_column).'),
      use_sheet_filter: lenientBoolean().optional().describe('Only the rows the sheet\'s saved filter shows'),
      target_row_ids: z.array(z.string()).min(1).max(MAX_SELECTED_ROWS).optional()
        .describe(`Stable row ids (from read_rows) to run, up to ${MAX_SELECTED_ROWS.toLocaleString('en-US')}`),
      test: lenientBoolean().optional().describe(`Run the first ${ENRICH_TEST_ROWS} rows only`),
      where: z.array(condition).max(20).optional().describe('Older form of run_if: only rows matching all of these'),
      run_if: runIfSchema,
      list: z.object({
        destination_sheet_id: z.string().optional(), new_sheet_name: z.string().max(200).optional(),
        provider: z.string().optional(),
        results_per_row: z.number().int().min(1).max(ENRICH_LIST_MAX_ITEMS).optional(),
        fields: z.array(z.object({ path: z.string(), column_name: z.string() }).strict()).optional(),
        copy_columns: z.array(z.object({ from: z.string(), to: z.string().optional() }).strict()).optional(),
        dedupe_path: z.string().optional().describe('Skip a result whose value here was added before'),
      }).strict().optional(),
      auto_run: z.object({ enabled: lenientBoolean(), daily_cap_usd: money().optional() }).strict().optional(),
      estimate_only: lenientBoolean().optional(),
      idempotency_key: z.string().min(1).max(200).optional(),
    }).strict(),
  }, async (args: TokenEnrichArgs) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const r = await tokenStartEnrichmentRun(ctx, args);
    return 'fail' in r ? err(r.message) : ok(r.ok);
  });
}
