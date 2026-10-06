// Enrichment run-start tools: thin wrappers over services/run-start-token*.ts,
// the same implementation POST /v1/sheets/:id/{ai,http}-runs uses (estimate,
// preview, structured output, idempotency, the per-token start window). The
// scope check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  MAX_ROWS_PER_SHEET, HTTP_DEFAULT_BATCH_SIZE, HTTP_MAX_CONCURRENCY, HTTP_MIN_TIMEOUT_MS, HTTP_MAX_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS,
} from '../lib/constants';
import { PREVIEW_MAX_ROWS, MAX_AI_CONCURRENCY, FREE_MODEL_CONCURRENCY_WARN, MAX_SEARCHES_PER_ROW } from '../lib/constants-ai';
import { MCP_EFFICIENT_ROWS_ENABLED } from '../lib/api-v1-constants';
import { SEARCH_ENGINES, SEARCH_MODES } from '../lib/web-search-options';
import { tokenStartAiRun, type TokenAiRunArgs } from '../services/run-start-token';
import { tokenStartHttpRun, type TokenHttpRunArgs } from '../services/run-start-token-http';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, lenientInt } from './tool-helpers';

const idempotencyKeySchema = z.string().min(1).max(200).optional();

const targetRowIdsSchema = z.array(z.string()).min(1).max(MAX_ROWS_PER_SHEET).optional();

// Engine and mode names, case-insensitive.
const lowercased = <T extends [string, ...string[]]>(values: T) =>
  z.preprocess(v => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(values));
const ALL_MODES = [...new Set([...SEARCH_MODES.exa, ...SEARCH_MODES.parallel])] as [string, ...string[]];

export function registerRunStartTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'run_ai_column',
    {
      description:
        `Run an AI prompt per row. DEFAULT: writes one "<column_name> (Output)" column. STRUCTURED: pass output_columns to write SEVERAL typed columns from ONE call per row (e.g. a score AND a reason) — never run a second AI pass to reformat or extract from a prior run's output${MCP_EFFICIENT_ROWS_ENABLED ? '; and for pure string ops (extract/split/case/template) use transform_column (no AI cost)' : ''}. The prompt references other columns as /column_name: the name in lowercase with each run of other characters turned into _ ("What they sell (Output)" is /what_they_sell_output); an unknown or misspelled one is rejected with a suggestion. Returns a run_id immediately — poll get_run_status; rows show "⏳ Processing..." until done. Model resolves: explicit > sheet default > account default (errors if none). Omit target_row_ids to run every row. WEB: web_search lets the model search, web_fetch lets it read pages, but only on the sites named in the cells your prompt references (reference /domain or /website to keep each row on its own site). Both work with output_columns: the same single call fills the typed columns plus a "<column_name> (Data)" column listing the sources it used. SEARCH COST: search fees are usually most of a web run's cost. Choose the engine with search_engine (parallel in turbo or fast mode is the cheapest, $0.001 a search) and limit searches with max_searches_per_row; estimate_only names the engine the run will really use and prices it. Every row records its search words, how many searches ran and what it cost: get_run_results returns them and the (Data) cell shows them in short. COST: one AI call PER ROW, plus web fees when web_search or web_fetch is on. Call estimate_only:true for a priced range (web fees included), or preview_rows:N to see real sample outputs, their sources, searches and the measured cost before committing.`,
      inputSchema: {
        sheet_id: z.string(),
        column_name: z.string().describe('Base column name; default mode creates "<name> (Output)". With output_columns, this names the "<name> (Status)" column.'),
        prompt: z.string().describe('Per-row prompt; reference columns as /column_name'),
        output_columns: z.array(z.object({
          column_name: z.string().describe('Column to create for this field'),
          type: z.enum(['string', 'number', 'boolean']).describe('number/boolean are sortable + usable by where gt/lt'),
          description: z.string().describe('Tells the model what to put in this column'),
        })).min(1).optional().describe('Structured output: one JSON object per row split into these typed columns, in a SINGLE AI call. Omit for classic single-column mode.'),
        model: z.string().optional().describe('OpenRouter model id, e.g. openai/gpt-4o-mini'),
        concurrency: z.number().int().min(1).max(MAX_AI_CONCURRENCY).optional()
          .describe(`How many rows to process IN PARALLEL (1-${MAX_AI_CONCURRENCY}). This is the main throughput lever: a 1,000-row run at 5 takes ~20x longer than at 100. Omit to use the sheet's saved default. PAID OpenRouter models tolerate the full range; FREE models (ids ending ":free") rate-limit hard above ~${FREE_MODEL_CONCURRENCY_WARN} — going higher there causes per-row 429 failures, not speed.`),
        system_prompt: z.string().optional(),
        web_search: lenientBoolean().optional().describe('Let the model search the web. Adds a "(Data)" column with the sources, search words and cost of each row. Works with output_columns.'),
        search_engine: lowercased([...SEARCH_ENGINES]).optional().describe(
          "Engine web_search runs on (needs web_search). auto (default): the model's own search if it has one (OpenAI, Anthropic, Google, xAI models; billed by that provider at its list price: OpenAI about $0.01 a search, $0.025 on GPT-4.1), otherwise Exa. "
          + 'native: the model\'s own search. exa: $0.007 a search ($0.012-$0.015 in deep modes). parallel: $0.005 a search, or $0.001 in turbo or fast mode. perplexity: $0.005. '
          + 'Prices as of October 2026; estimate_only reports the live price of what will run.'),
        search_mode: lowercased(ALL_MODES).optional().describe(
          'Needs search_engine exa or parallel (not auto). Deeper modes search more thoroughly, take longer and cost more. '
          + 'exa: instant, fast, auto (default) $0.007; deep-lite, deep $0.012; deep-reasoning $0.015. '
          + 'parallel: turbo, fast $0.001; basic (default), advanced $0.005; turbo covers English and Japanese only.'),
        max_searches_per_row: lenientInt(1, MAX_SEARCHES_PER_ROW).optional().describe(
          `Hard limit on searches per row (1-${MAX_SEARCHES_PER_ROW}; needs web_search). OpenRouter enforces it on exa, parallel and perplexity, and on Anthropic models' own search; a row that reaches it is made to answer. `
          + "Other models' own search (OpenAI, Google, xAI) can't be limited: with search_engine auto Cubex then uses Exa (web_search.switched is true in the response), with native the run is refused."),
        web_fetch: lenientBoolean().optional().describe('Let the model open web pages, limited per row to the sites in the cells the prompt references (a URL or a bare domain such as stripe.com). With output_columns, the "(Data)" column lists the pages it used.'),
        target_row_ids: targetRowIdsSchema.describe('Stable row ids (from read_rows) to run; omit for all rows'),
        estimate_only: lenientBoolean().optional().describe('Dry run: return { rows_to_process, model, estimated_cost_usd:{low,high}, web_fees_usd, web_search:{engine, runs_on, mode, price_per_search_usd, searches_per_row, switched, ...}, ... } and start nothing. No AI calls, no columns created. In web_search, engine is what the run sends, runs_on is what runs the searches, and mode is the one billed (the engine\'s default when you chose none).'),
        preview_rows: lenientInt(1, PREVIEW_MAX_ROWS).optional().describe(`Run the prompt on the first N rows (max ${PREVIEW_MAX_ROWS}) with the same web tools, and return the sample outputs (with their sources, search words and cost) + MEASURED cost + full-run projection. Nothing is created or saved: validate a prompt before the full run.`),
        idempotency_key: idempotencyKeySchema.describe('Stable retry key: retrying with the same key + same args returns the original run_id instead of starting a second run (safe retries after a timeout/limit).'),
      },
    },
    async (args: TokenAiRunArgs) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const r = await tokenStartAiRun(ctx, args);
      return 'fail' in r ? err(r.message) : ok(r.ok);
    },
  );

  registerTool(server, 
    'run_http_enrichment',
    {
      description:
        `Call an HTTP JSON API once per row and extract response fields into new columns. url/headers/body templates substitute {{column_name}} (or /column_name) per row; an empty cell substitutes as empty, and a {{name}} that matches no column or saved key is rejected at start. Each response_mapping entry JSONPath-extracts one field (e.g. $.results[0].email) into column_name; a path matching several values keeps the first, and an object or array is stored as JSON text. A master status column tracks per-row ✅/❌. JSON responses only. Requests go ${HTTP_DEFAULT_BATCH_SIZE} at a time (batch_size); GET/HEAD responses are cached for 5 minutes, so an identical re-run within that window reuses them; private and internal addresses are always blocked. Returns a run_id — poll get_run_status (it counts failed rows). estimate_only checks the URL and {{names}} without sending anything. Referencing a saved API key by name requires the token to have the "secrets" scope.`,
      inputSchema: {
        sheet_id: z.string(),
        url: z.string().describe('Request URL template, e.g. https://api.example.com/lookup?domain={{Domain}}'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('Default GET'),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional().describe('Request body template (POST/PUT only)'),
        response_mapping: z.array(z.object({
          json_path: z.string().describe('JSONPath into the response, e.g. $.title'),
          column_name: z.string().describe('New column to hold the extracted value'),
        })).min(1),
        master_column_name: z.string().optional().describe('Name for the per-row status column; auto-named if omitted'),
        batch_size: z.number().int().min(1).max(HTTP_MAX_CONCURRENCY).optional()
          .describe(`Requests sent at once (default ${HTTP_DEFAULT_BATCH_SIZE}). Raise only if the API allows it.`),
        timeout_ms: z.number().int().min(HTTP_MIN_TIMEOUT_MS).max(HTTP_MAX_TIMEOUT_MS).optional()
          .describe(`Per-request timeout (default ${HTTP_REQUEST_TIMEOUT_MS} ms).`),
        target_row_ids: targetRowIdsSchema.describe('Stable row ids to run; omit for all rows'),
        estimate_only: lenientBoolean().optional().describe('Dry run: return { rows_to_process, ... } and start nothing. HTTP enrichment has no AI cost (runs against your own API).'),
        idempotency_key: idempotencyKeySchema.describe('Stable retry key: retrying with the same key + same args returns the original run_id instead of starting a second run.'),
      },
    },
    async (args: TokenHttpRunArgs) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const r = await tokenStartHttpRun(ctx, args);
      return 'fail' in r ? err(r.message) : ok(r.ok);
    },
  );
}
