// Over 200 lines: the two run-start tools (AI and HTTP) with their input schemas, one registration each.
// Enrichment run-start tools: thin wrappers over services/run-start-token*.ts,
// the same implementation POST /v1/sheets/:id/{ai,http}-runs uses (estimate,
// preview, structured output, idempotency, the per-token start window). The
// scope check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  MAX_ROWS_PER_SHEET, HTTP_DEFAULT_BATCH_SIZE, HTTP_MAX_CONCURRENCY, HTTP_MIN_TIMEOUT_MS, HTTP_MAX_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS,
  CURL_MAX_CHARS, HTTP_RETRY_DEFAULT, HTTP_RETRY_MAX, HTTP_STATUS_PATH, RUN_SPEND_LIMIT_MAX_USD,
} from '../lib/constants';
import {
  PREVIEW_MAX_ROWS, MAX_AI_CONCURRENCY, FREE_MODEL_CONCURRENCY_WARN, MAX_SEARCHES_PER_ROW,
  WEB_FETCH_MAX_CONTENT_TOKENS_MIN, WEB_FETCH_MAX_CONTENT_TOKENS_MAX, WEB_FETCH_MAX_PAGES_PER_ROW,
} from '../lib/constants-ai';
import { MAX_CONTENT_TOKENS_RANGE, MAX_PAGES_RANGE } from '../lib/web-fetch-options';
import { SEARCH_ENGINES, SEARCH_MODES } from '../lib/web-search-options';
import { tokenStartAiRun, type TokenAiRunArgs } from '../services/run-start-token';
import { tokenStartHttpRun, type TokenHttpRunArgs } from '../services/run-start-token-http';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, lenientInt, SHEET_ID } from './tool-helpers';
import { runIfSchema } from './run-if-schema';
import { capToolNote } from '../lib/token-spend';
import { AI_SPEND_LIMIT_NOTE } from '../lib/ai-spend-limit';

const idempotencyKeySchema = z.string().min(1).max(200).optional();
const webhookIdSchema = z.string().optional().describe(
  'A run webhook (list_run_webhooks) to notify when this run finishes, with a signed POST. Delivery isn\'t '
  + 'guaranteed: keep polling get_run_status, the notice only saves polls.');

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
        'Fill a column by running an AI prompt on each row: one OpenRouter call per row, paid. Prefer the free '
        + 'tools when they can do it: clean_column, formula_column, transform_column, lookup_column. For one value '
        + 'from several sources use waterfall_column; for treg.to data, run_enrichment. '
        + 'Writes "<column_name> (Output)"; output_columns writes several typed columns from ONE call per row (never '
        + 'run a second AI pass to reformat a first). A new run with output_columns on existing columns is refused. '
        + 'The prompt names columns as /column_name: lowercase, each run of other characters as _. Model: model, '
        + 'else the sheet\'s default, else the account\'s (list_models). '
        + 'Returns run_id at once: poll get_run_status, then read_rows or get_run_results. After a target_row_ids '
        + 'test, finish with control_run rerun mode "empty". '
        + 'web_search and web_fetch work only on the sites in the cells the prompt references; search fees are '
        + 'usually most of the cost (search_engine, max_searches_per_row). '
        + 'COST CEILING: max_cost_usd refuses to start when the estimate\'s high end plus one row\'s most is above '
        + 'it, or the model has no known price unless allow_unpriced is true. It is also the run\'s hard spend '
        + 'limit; spend_limit_usd sets one without the check (with both, the lower one). '
        + AI_SPEND_LIMIT_NOTE
        + capToolNote(ctx.spend ?? null, true),
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        column_name: z.string()
          .describe('Base name: creates "<name> (Output)", or with output_columns the "<name> (Status)" column'),
        prompt: z.string().describe('Per-row prompt; reference columns as /column_name'),
        output_columns: z.array(z.object({
          column_name: z.string().describe('Column to create for this field'),
          type: z.enum(['string', 'number', 'boolean']).describe('number/boolean are sortable + usable by where gt/lt'),
          description: z.string().describe('Tells the model what to put in this column'),
        })).min(1).optional()
          .describe('Typed columns filled from one JSON answer per row, in a SINGLE AI call. Omit for one column.'),
        model: z.string().optional().describe('OpenRouter model id, e.g. openai/gpt-4o-mini'),
        concurrency: z.number().int().min(1).max(MAX_AI_CONCURRENCY).optional()
          .describe(`Rows at once, 1-${MAX_AI_CONCURRENCY}: the main speed lever. Default: the sheet's saved one. `
            + `Free models (ids ending ":free") fail with 429 above about ${FREE_MODEL_CONCURRENCY_WARN}.`),
        system_prompt: z.string().optional().describe('Instructions sent before each row\'s prompt'),
        web_search: lenientBoolean().optional()
          .describe('Let the model search the web. Adds a "(Data)" column with each row\'s sources and cost.'),
        search_engine: lowercased([...SEARCH_ENGINES]).optional().describe(
          'Needs web_search. auto (default): the model\'s own search if it has one (billed by its provider, OpenAI '
          + 'about $0.01 a search), else Exa. native: the model\'s own. exa: $0.007 a search ($0.012-$0.015 deep). '
          + 'parallel: $0.005, or $0.001 in turbo or fast mode. perplexity: $0.005.'),
        search_mode: lowercased(ALL_MODES).optional().describe(
          'Needs search_engine exa or parallel. exa: instant, fast, auto (default) $0.007; deep-lite, deep $0.012; '
          + 'deep-reasoning $0.015. parallel: turbo (English and Japanese only), fast $0.001; basic (default), '
          + 'advanced $0.005.'),
        max_searches_per_row: lenientInt(1, MAX_SEARCHES_PER_ROW).optional().describe(
          `Most searches a row (1-${MAX_SEARCHES_PER_ROW}; needs web_search). OpenAI, Google and xAI models' own `
          + 'search can\'t be capped: search_engine auto then uses Exa, native is refused.'),
        web_fetch: lenientBoolean().optional().describe('Let the model open web pages, per row only on the sites (a '
          + 'URL or bare domain) in the cells the prompt references. Adds the "(Data)" column.'),
        max_content_tokens: lenientInt(WEB_FETCH_MAX_CONTENT_TOKENS_MIN, WEB_FETCH_MAX_CONTENT_TOKENS_MAX,
          `max_content_tokens must be ${MAX_CONTENT_TOKENS_RANGE}.`).optional().describe(
          `Cut each page web_fetch reads to about this many tokens (${WEB_FETCH_MAX_CONTENT_TOKENS_MIN}-`
          + `${WEB_FETCH_MAX_CONTENT_TOKENS_MAX}). With it or max_pages_per_row pages are read through Exa ($0.001 `
          + 'a page); an OpenRouter workspace that limits web fetch engines must allow Exa, or the run pauses.'),
        max_pages_per_row: lenientInt(1, WEB_FETCH_MAX_PAGES_PER_ROW, `max_pages_per_row must be ${MAX_PAGES_RANGE}.`)
          .optional().describe(`Most pages web_fetch may read for one row (1-${WEB_FETCH_MAX_PAGES_PER_ROW}), `
          + 'through Exa; then the model answers from what it read.'),
        target_row_ids: targetRowIdsSchema.describe('Stable row ids (from read_rows) to run; omit for all rows'),
        run_if: runIfSchema,
        estimate_only: lenientBoolean().optional().describe('Price it and start nothing (no AI calls, no '
          + 'columns): rows_to_process, estimated_cost_usd, per_row_usd {low, high}, web_fees_usd, web_search, '
          + 'in_flight (OpenRouter holds each running call\'s possible cost, also on your own provider key, so a high '
          + 'concurrency can be refused with 402 before the balance runs out: follow its warning), own_provider_key '
          + 'and assumptions. Default false'),
        preview_rows: lenientInt(1, PREVIEW_MAX_ROWS).optional().describe(`Run the prompt for real on the first N `
          + `rows (up to ${PREVIEW_MAX_ROWS}): each output with its sources, cost, paid_with and tokens, and a `
          + 'full-run projection. Nothing is created. On your own provider key cost_usd is only OpenRouter\'s fee: '
          + 'projected_total_usd adds the provider\'s bill. Later estimates of this prompt use what it measured.'),
        idempotency_key: idempotencyKeySchema
          .describe('A retry with the same key and arguments returns the first run_id instead of starting another'),
        webhook_id: webhookIdSchema,
        max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional().describe(
          'Refuse to start when the estimate could cost more than this many dollars; also the run\'s hard spend '
          + 'limit. Check it first with estimate_only.'),
        allow_unpriced: lenientBoolean().optional().describe(
          'With max_cost_usd: start even when the model has no known price (default false). Such a run stops '
          + 'only once what was billed reaches the limit.'),
        spend_limit_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional().describe(
          'The run\'s hard spend limit in dollars: it pauses before a row that could pass it (pause_reason '
          + 'spend_limit). control_run resume with a higher spend_limit_usd goes on.'),
      },
    },
    async (args: TokenAiRunArgs) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const r = await tokenStartAiRun(ctx, args);
      if (!('fail' in r)) return ok({ ...r.ok, changed: r.changed ?? [] });
      return err(r.fail === 'over_ceiling' ? `${r.message} Estimate: ${JSON.stringify(r.estimate)}` : r.message);
    },
  );

  registerTool(server, 
    'run_http_enrichment',
    {
      description:
        'Call your own HTTP JSON API once per row and put fields of each answer into new columns. For treg.to '
        + 'data use run_enrichment. url, headers and body fill {{column_name}} per row (cell values escaped for '
        + 'where they go); a {{name}} that is no column or saved key is refused at start. Or pass curl, a whole cURL '
        + 'command: a key in it is never stored in the column; save_keys saves it as a saved key (needs the '
        + '"secrets" scope, as does naming a saved key), or write {{key_name}} of a saved key in its place; a '
        + '$VARIABLE in a key\'s spot uses the saved key with that name. Each response_mapping entry takes one '
        + 'JSONPath field into a column (the first match; an object or list as JSON text; filters are refused: map $ '
        + 'and read it with formula_column). JSON answers only; private and internal addresses are blocked; GET and '
        + 'HEAD answers are reused for 5 minutes. RETRIES: 429 and 503 (any method), another 5xx or no answer for '
        + 'GET, PUT and DELETE (POST with retry_post), following Retry-After up to 60 s; a 4xx never. Returns run_id '
        + 'at once: poll get_run_status, then read_rows or get_run_results. '
        + 'estimate_only checks the URL and {{names}} without sending anything.',
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        url: z.string().optional().describe(
          'Request URL template, e.g. https://api.example.com/lookup?domain={{Domain}}. Required unless curl is given.',
        ),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('Default GET'),
        headers: z.record(z.string(), z.string()).optional()
          .describe('Header name -> value template, {{column_name}} and saved keys filled per row'),
        body: z.string().optional().describe('Request body template (POST, PUT and DELETE)'),
        curl: z.string().max(CURL_MAX_CHARS).optional()
          .describe('A whole cURL command, in place of url/method/headers/body. {{column_name}} works inside it.'),
        save_keys: z.union([lenientBoolean(), z.record(z.string(), z.string())]).optional()
          .describe('With curl: true saves each key in the command as a saved key under a suggested name, or '
            + '{ "<where>": "<name>" } for every key (e.g. { "Authorization header": "openai" }) picks the names.'),
        response_mapping: z.array(z.object({
          json_path: z.string()
            .describe(`JSONPath into the response, e.g. $.title, or "${HTTP_STATUS_PATH}" for the HTTP status code`),
          column_name: z.string().describe('New column to hold the extracted value'),
        })).min(1).describe('Which fields of each answer go into which new columns'),
        master_column_name: z.string().optional().describe('Name for the per-row status column; auto-named if omitted'),
        batch_size: z.number().int().min(1).max(HTTP_MAX_CONCURRENCY).optional()
          .describe(`Requests sent at once (default ${HTTP_DEFAULT_BATCH_SIZE}). Raise only if the API allows it.`),
        timeout_ms: z.number().int().min(HTTP_MIN_TIMEOUT_MS).max(HTTP_MAX_TIMEOUT_MS).optional()
          .describe(`Per-request timeout (default ${HTTP_REQUEST_TIMEOUT_MS} ms).`),
        retries: lenientInt(0, HTTP_RETRY_MAX).optional()
          .describe(`More tries for a request that failed in a way a retry can fix (0-${HTTP_RETRY_MAX}, `
            + `default ${HTTP_RETRY_DEFAULT}).`),
        retry_post: lenientBoolean().optional()
          .describe('Also retry POST on a 5xx or no answer. Only if the API is safe to call twice. Default false.'),
        skip_empty_values: lenientBoolean().optional()
          .describe('Leave out a query parameter or body field whose {{column}} is empty. Default false.'),
        status_code_column: z.string().optional().describe('New column to hold the HTTP status code of each row'),
        target_row_ids: targetRowIdsSchema.describe('Stable row ids to run; omit for all rows'),
        run_if: runIfSchema,
        estimate_only: lenientBoolean().optional()
          .describe('Dry run: rows_to_process and checks, nothing started. No AI cost (it calls your own API).'),
        idempotency_key: idempotencyKeySchema
          .describe('A retry with the same key and arguments returns the first run_id instead of starting another'),
        webhook_id: webhookIdSchema,
      },
    },
    async (args: TokenHttpRunArgs) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const r = await tokenStartHttpRun(ctx, args);
      if ('fail' in r) return err(r.message);
      return ok({ ...r.ok, changed: r.changed ?? [] });
    },
  );
}
