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
        + 'tools when they can do it: clean_column (names, companies, emails, domains, phones, case, spaces), '
        + 'formula_column or transform_column (extract, split, join, math, templates), lookup_column (values from '
        + 'another sheet). For one value from several sources in order use waterfall_column; for treg.to data, '
        + 'run_enrichment. '
        + 'Writes "<column_name> (Output)". STRUCTURED: output_columns writes several typed columns from ONE call '
        + 'per row (a score and a reason): never run a second AI pass to reformat or extract from a first one. A new '
        + 'run with output_columns on columns that exist is refused. '
        + 'The prompt names columns as /column_name: lowercase, each run of other characters as _ ("What they sell '
        + '(Output)" is /what_they_sell_output); an unknown one is refused with a suggestion. The model: model, '
        + 'else the sheet\'s default, else the account\'s (list_models, set_default_model). '
        + 'Returns run_id at once: poll get_run_status (cells read "⏳ Processing..." until done), then read_rows or '
        + 'get_run_results. target_row_ids runs only those rows; after such a test, finish the sheet with '
        + 'control_run rerun, mode "empty". run_if skips rows that fail a rule (no AI call, "⏭️ Condition not '
        + 'met"), so each column of a chain runs only where the one before said so. '
        + 'WEB: web_search lets the model search and web_fetch read pages, only on the sites in the cells the '
        + 'prompt references (reference /domain or /website to keep each row on its own site). Both work with '
        + 'output_columns and add "<column_name> (Data)" listing the sources. Search fees are usually most of a '
        + 'web run\'s cost: pick search_engine (parallel in turbo or fast mode costs $0.001 a search) and cap '
        + 'max_searches_per_row; each row records its searches and cost (get_run_results). '
        + 'COST: estimate_only prices it (web fees included); preview_rows runs a few rows for real and measures. '
        + 'COST CEILING: max_cost_usd refuses to start (nothing created) when the estimate\'s high end plus one '
        + 'row\'s most (row_most_usd) is above it, or when the model has no known price unless allow_unpriced is '
        + 'true (estimate_only says over_ceiling and ceiling_problem instead). It is also the run\'s hard spend '
        + 'limit; spend_limit_usd sets one without the check (with both, the lower one). '
        + AI_SPEND_LIMIT_NOTE
        + capToolNote(ctx.spend ?? null, true),
      inputSchema: {
        sheet_id: z.string().describe(SHEET_ID),
        column_name: z.string().describe('Base column name; default mode creates "<name> (Output)". With output_columns, this names the "<name> (Status)" column.'),
        prompt: z.string().describe('Per-row prompt; reference columns as /column_name'),
        output_columns: z.array(z.object({
          column_name: z.string().describe('Column to create for this field'),
          type: z.enum(['string', 'number', 'boolean']).describe('number/boolean are sortable + usable by where gt/lt'),
          description: z.string().describe('Tells the model what to put in this column'),
        })).min(1).optional().describe('Structured output: one JSON object per row split into these typed columns, in a SINGLE AI call. Omit for classic single-column mode.'),
        model: z.string().optional().describe('OpenRouter model id, e.g. openai/gpt-4o-mini'),
        concurrency: z.number().int().min(1).max(MAX_AI_CONCURRENCY).optional()
          .describe(`Rows at once, 1-${MAX_AI_CONCURRENCY}: the main speed lever (1,000 rows at 5 take about 20 `
            + 'times longer than at 100). Default: the sheet\'s saved one. Free models (ids ending ":free") fail with '
            + `429 above about ${FREE_MODEL_CONCURRENCY_WARN}.`),
        system_prompt: z.string().optional().describe('Instructions sent before each row\'s prompt'),
        web_search: lenientBoolean().optional().describe('Let the model search the web. Adds a "(Data)" column with the sources, search words and cost of each row. Works with output_columns.'),
        search_engine: lowercased([...SEARCH_ENGINES]).optional().describe(
          'Engine web_search runs on (needs web_search). auto (default): the model\'s own search if it has one '
          + '(OpenAI, Anthropic, Google, xAI models; billed by that provider, OpenAI about $0.01 a search), else '
          + 'Exa. native: the model\'s own. exa: $0.007 a search ($0.012-$0.015 deep). parallel: $0.005, or $0.001 '
          + 'in turbo or fast mode. perplexity: $0.005. estimate_only gives the live price of what will run.'),
        search_mode: lowercased(ALL_MODES).optional().describe(
          'Needs search_engine exa or parallel (not auto). Deeper modes search more thoroughly, take longer and cost more. '
          + 'exa: instant, fast, auto (default) $0.007; deep-lite, deep $0.012; deep-reasoning $0.015. '
          + 'parallel: turbo, fast $0.001; basic (default), advanced $0.005; turbo covers English and Japanese only.'),
        max_searches_per_row: lenientInt(1, MAX_SEARCHES_PER_ROW).optional().describe(
          `Most searches a row (1-${MAX_SEARCHES_PER_ROW}; needs web_search); a row that reaches it answers. `
          + 'OpenAI, Google and xAI models\' own search can\'t be capped: search_engine auto then uses Exa '
          + '(web_search.switched true), native is refused.'),
        web_fetch: lenientBoolean().optional().describe('Let the model open web pages, limited per row to the sites in the cells the prompt references (a URL or a bare domain such as stripe.com). With output_columns, the "(Data)" column lists the pages it used.'),
        max_content_tokens: lenientInt(WEB_FETCH_MAX_CONTENT_TOKENS_MIN, WEB_FETCH_MAX_CONTENT_TOKENS_MAX,
          `max_content_tokens must be ${MAX_CONTENT_TOKENS_RANGE}.`).optional().describe(
          `Cut each page web_fetch reads to about this many tokens (${WEB_FETCH_MAX_CONTENT_TOKENS_MIN}-`
          + `${WEB_FETCH_MAX_CONTENT_TOKENS_MAX}; needs web_fetch), which bounds what a row costs. With it or `
          + 'max_pages_per_row pages are read through Exa ($0.001 a page); an OpenRouter workspace that limits '
          + 'web fetch engines must allow Exa, or the run pauses (pause_reason web_engine).'),
        max_pages_per_row: lenientInt(1, WEB_FETCH_MAX_PAGES_PER_ROW, `max_pages_per_row must be ${MAX_PAGES_RANGE}.`)
          .optional().describe(`Most pages web_fetch may read for one row (1-${WEB_FETCH_MAX_PAGES_PER_ROW}, `
          + 'Cubex\'s own cap: Exa has none; needs web_fetch); further fetches are refused and the model answers '
          + 'from what it read. Read through Exa, as with max_content_tokens.'),
        target_row_ids: targetRowIdsSchema.describe('Stable row ids (from read_rows) to run; omit for all rows'),
        run_if: runIfSchema,
        estimate_only: lenientBoolean().optional().describe('Price it and start nothing (no AI calls, no '
          + 'columns): rows_to_process, model, estimated_cost_usd and per_row_usd {low, high}, web_fees_usd, '
          + 'web_search (engine: what the run sends; runs_on: what runs the searches; mode: the one billed), '
          + 'in_flight (OpenRouter holds each running call\'s possible cost, so a high concurrency can be refused '
          + 'with 402 before the balance runs out: follow its warning; on your own provider key too, since a row '
          + 'your key can\'t serve falls back to OpenRouter credits and is held), own_provider_key (your latest run '
          + 'on this model used your own key) and assumptions (history_from: where the output size came from). '
          + 'Default false'),
        preview_rows: lenientInt(1, PREVIEW_MAX_ROWS).optional().describe(`Run the prompt for real on the first N `
          + `rows (up to ${PREVIEW_MAX_ROWS}) with the same web tools: each output with its sources, searches, cost, `
          + 'paid_with ("own_key", or "credits" when OpenRouter fell back to its credits) and tokens, the measured '
          + 'cost and a full-run projection. Nothing is created or saved. On '
          + 'your own provider key cost_usd is only OpenRouter\'s fee: provider_cost and projected_total_usd add '
          + 'what the provider bills. Later estimates of this prompt use what it measured.'),
        idempotency_key: idempotencyKeySchema.describe('Stable retry key: retrying with the same key + same args returns the original run_id instead of starting a second run (safe retries after a timeout/limit).'),
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
      if (!('fail' in r)) return ok(r.ok);
      return err(r.fail === 'over_ceiling' ? `${r.message} Estimate: ${JSON.stringify(r.estimate)}` : r.message);
    },
  );

  registerTool(server, 
    'run_http_enrichment',
    {
      description:
        'Call your own HTTP JSON API once per row and put fields of each answer into new columns. For treg.to '
        + 'data use run_enrichment; to pick an item of an answer by a condition, map $ (the whole answer) and add '
        + 'a formula_column reading it (JSONPath filters are refused). url, headers and body fill {{column_name}} '
        + '(or /column_name) per row; an empty cell fills as empty, and a {{name}} that is no column or saved key '
        + 'is refused at start. Or pass curl: a whole cURL command, e.g. from the API\'s docs. A key Cubex finds in '
        + 'it is never stored in the column: save_keys saves it as a saved key (needs the "secrets" scope, as does '
        + 'naming a saved key), or write {{key_name}} of a saved key in its place; a $VARIABLE in a key\'s spot '
        + 'uses the saved key with that name. Cell values are escaped for where they go (JSON in a JSON body, '
        + 'encoded in a query value); saved keys go in as saved. '
        + 'Each response_mapping entry takes one field (e.g. $.results[0].email) into column_name: the first of '
        + 'several matches, an object or list as JSON text. A status column tracks each row ✅/❌. JSON answers '
        + `only. Requests go ${HTTP_DEFAULT_BATCH_SIZE} at a time (batch_size); GET and HEAD answers are kept 5 `
        + 'minutes, so an identical rerun reuses them; private and internal addresses are blocked. RETRIES: 429 and '
        + '503 are sent again (any method), another 5xx or no answer for GET, PUT and DELETE (POST with '
        + `retry_post), up to retries more times (default ${HTTP_RETRY_DEFAULT}), following Retry-After up to 60 s; `
        + 'a 4xx never. Returns run_id at once: poll get_run_status (it counts failed rows), then read_rows or '
        + 'get_run_results. run_if skips rows that fail a rule (nothing sent, "⏭️ Condition not met"). '
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
        estimate_only: lenientBoolean().optional().describe('Dry run: return { rows_to_process, ... } and start nothing. HTTP enrichment has no AI cost (runs against your own API).'),
        idempotency_key: idempotencyKeySchema.describe('Stable retry key: retrying with the same key + same args returns the original run_id instead of starting a second run.'),
        webhook_id: webhookIdSchema,
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
