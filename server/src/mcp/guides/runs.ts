// The guides of the tools that start AI and HTTP API runs (guide.ts says what a guide holds).
import {
  MAX_SEARCHES_PER_ROW, PREVIEW_MAX_ROWS, WEB_FETCH_MAX_CONTENT_TOKENS_MAX, WEB_FETCH_MAX_CONTENT_TOKENS_MIN,
} from '../../lib/constants-ai';
import { AI_SPEND_LIMIT_NOTE } from '../../lib/ai-spend-limit';
import { RUN_IF_HELP } from '../run-if-schema';
import { saveOnlyHelp } from '../save-only-schema';
import type { ToolGuide } from './guide';

const WEBHOOK_ID_HELP = 'A run webhook (list_run_webhooks) to notify when this run finishes, with a signed POST. '
  + 'Delivery isn\'t guaranteed: keep polling get_run_status, the notice only saves polls.';

export const RUN_GUIDES: Record<string, ToolGuide> = {
  run_ai_column: {
    text: [
      'A new run with output_columns on existing columns is refused. After a target_row_ids test, finish with '
        + 'control_run rerun mode "empty".',
      'web_fetch reads pages only on the sites in the cells the prompt references (/domain or /website); '
        + 'web_search searches the web, and its fees are usually most of the cost (search_engine, '
        + 'max_searches_per_row).',
      `The run's spend limit (max_cost_usd or spend_limit_usd): ${AI_SPEND_LIMIT_NOTE}`,
    ],
    fields: {
      search_engine: 'Needs web_search. auto (default): the model\'s own search if it has one (billed by its '
        + 'provider, OpenAI about $0.01 a search), else Exa. native: the model\'s own. exa: $0.007 a search '
        + '($0.012-$0.015 deep). parallel: $0.005, or $0.001 in turbo or fast mode. perplexity: $0.005.',
      search_mode: 'Needs search_engine exa or parallel. exa: instant, fast, auto (default) $0.007; deep-lite, deep '
        + '$0.012; deep-reasoning $0.015. parallel: turbo (English and Japanese only), fast $0.001; basic (default), '
        + 'advanced $0.005.',
      max_searches_per_row: `Most searches a row (1-${MAX_SEARCHES_PER_ROW}; needs web_search). OpenAI, Google and `
        + 'xAI models\' own search can\'t be capped: search_engine auto then uses Exa, native is refused.',
      web_fetch: 'Let the model open web pages, per row only on the sites (a URL or bare domain) in the cells the '
        + 'prompt references. With output_columns, the "(Data)" column lists the pages it used.',
      max_content_tokens: 'Cut each page web_fetch reads to about this many tokens '
        + `(${WEB_FETCH_MAX_CONTENT_TOKENS_MIN}-${WEB_FETCH_MAX_CONTENT_TOKENS_MAX}). With it or max_pages_per_row `
        + 'pages are read through Exa ($0.001 a page); an OpenRouter workspace that limits web fetch engines must '
        + 'allow Exa, or the run pauses.',
      run_if: RUN_IF_HELP,
      save_only: saveOnlyHelp('run_ai_column'),
      estimate_only: 'Price it and start nothing (no AI calls, no columns): rows_to_process, estimated_cost_usd, '
        + 'per_row_usd {low, high}, web_fees_usd, web_search, in_flight (OpenRouter holds each running call\'s '
        + 'possible cost, also on your own provider key, so a high concurrency can be refused with 402 before the '
        + 'balance runs out: follow its warning), own_provider_key and assumptions. Default false',
      preview_rows: `Run the prompt for real on the first N rows (up to ${PREVIEW_MAX_ROWS}): each output with its `
        + 'sources, cost, paid_with and tokens, and a full-run projection. Nothing is created. On your own provider '
        + 'key cost_usd is only OpenRouter\'s fee: projected_total_usd adds the provider\'s bill. Later estimates of '
        + 'this prompt use what it measured.',
      webhook_id: WEBHOOK_ID_HELP,
    },
    spendCap: true,
  },
  run_http_enrichment: {
    text: [
      'Or pass curl, a whole cURL command: a key in it is never stored in the column; save_keys saves it as a saved '
        + 'key (needs the "secrets" scope, as does naming a saved key), or write {{key_name}} of a saved key in its '
        + 'place; a $VARIABLE in a key\'s spot uses the saved key with that name.',
      'RETRIES: 429 and 503 (any method), another 5xx or no answer for GET, PUT and DELETE (POST with retry_post), '
        + 'following Retry-After up to 60 s; a 4xx never.',
    ],
    fields: {
      save_keys: 'With curl: true saves each key in the command as a saved key under a suggested name, or '
        + '{ "<where>": "<name>" } for every key (e.g. { "Authorization header": "openai" }) picks the names.',
      run_if: RUN_IF_HELP,
      save_only: saveOnlyHelp('run_http_enrichment'),
      webhook_id: WEBHOOK_ID_HELP,
    },
  },
  write_run_condition: {
    text: [
      'The model sees the column names and a few values from the first rows, so the rule matches the sheet\'s real '
        + 'spelling. Returns the rule, the model used, what the call cost, and the same check as check_run_condition.',
    ],
  },
};
