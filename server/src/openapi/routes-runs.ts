// /api/v1 routes: starting AI and HTTP API runs, reading runs and their
// results, models, and "Only run if" rules (api-v1-runs.ts, api-v1-run-reads.ts,
// api-v1-run-conditions.ts).
import { z } from 'zod';
import { API_V1_DEFAULT_ROWS_PAGE, API_V1_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import { SAVED_KEYS_LISTED } from '../lib/api-v1-constants';
import { RUN_LIST_DEFAULT, RUN_LIST_MAX } from '../services/run-list';
import { op, type RouteDoc } from './route-doc';
import { toolBody } from './tool-schemas';

const idempotency = z.object({
  'Idempotency-Key': z.string().max(200).optional()
    .describe('Or idempotency_key in the body. A retry with the same key and arguments replays the first start.'),
});
const started = (poll: string) => ({
  202: `Started: the run_id to poll at ${poll}.`,
  200: 'An estimate, a preview, or a retry that replayed an earlier start.',
});
const resultsPage = z.object({
  limit: z.number().int().min(1).max(API_V1_MAX_ROWS_PAGE).optional()
    .describe(`Rows per page, 1 to ${API_V1_MAX_ROWS_PAGE}. Default ${API_V1_DEFAULT_ROWS_PAGE}.`),
  cursor: z.number().int().min(0).optional().describe('next_cursor from the previous page.'),
  status: z.enum(['failed', 'completed', 'all']).optional().describe('Which rows. Default all.'),
});
// POST /http-runs' earlier body shape, still read (api-v1-runs.ts).
const legacyConfig = z.object({
  requestConfig: z.object({
    url: z.string(), method: z.enum(['GET', 'POST', 'PUT', 'DELETE']), headers: z.record(z.string(), z.string()),
    body: z.string(), timeout: z.number().int().describe('Milliseconds.'), skipEmpty: z.boolean(),
  }).partial(),
  responseMapping: z.array(z.object({ jsonPath: z.string(), columnName: z.string() })),
  batchSize: z.number().int(), runIf: z.string(), retries: z.number().int(), retryPost: z.boolean(),
}).partial().describe('The earlier shape of this body. When given, url, method, headers, body, curl, save_keys, '
  + 'response_mapping, batch_size, timeout_ms, retries, retry_post and skip_empty_values come from it instead.');

export const runRoutes = (): RouteDoc[] => [
  op({
    method: 'post', path: '/sheets/{id}/ai-runs', operationId: 'startAiRun', tag: 'runs', scope: 'run',
    summary: 'Run an AI prompt on every row (or some), into one column or several typed ones.',
    description: 'One AI call per row, which costs money: estimate_only or preview_rows first.',
    headers: idempotency,
    body: toolBody('run_ai_column', {
      omit: ['sheet_id'],
      extend: {
        temperature: z.number().min(0).max(2).optional().describe('0 to 2. Default 0.7.'),
        max_chars: z.number().int().min(1).max(100_000).optional()
          .describe('Room for longer answers: about how many characters a row may get.'),
      },
    }),
    responses: started('GET /ai-runs/{id}'),
  }),
  op({
    method: 'post', path: '/sheets/{id}/http-runs', operationId: 'startHttpRun', tag: 'runs', scope: 'run',
    summary: 'Call an HTTP JSON API once per row and put fields of each answer into new columns.',
    description: 'Saved keys in the request need the secrets scope.',
    headers: idempotency,
    body: toolBody('run_http_enrichment', { omit: ['sheet_id'], extend: { config: legacyConfig.optional() } }),
    responses: started('GET /http-runs/{id}'),
  }),
  op({
    method: 'get', path: '/models', operationId: 'listModels', tag: 'runs', scope: 'read',
    summary: "Find OpenRouter model ids, and the account's default model.",
    query: z.object({
      search: z.string().optional().describe('Words or an id. An exact id comes first.'),
      limit: z.number().int().min(1).max(500).optional().describe('At most this many. Default 50.'),
    }),
    responses: { 502: "OpenRouter couldn't be reached and no earlier list was kept." },
  }),
  op({
    method: 'get', path: '/saved-keys', operationId: 'listSavedKeys', tag: 'runs', scope: 'read',
    summary: 'The saved API keys by name and where each is used (columns and setups), never their values.',
    description: `As MCP's list_saved_keys: at most ${SAVED_KEYS_LISTED} keys a call, by name; pass next_after `
      + 'as after for more. Using a key in a request ({{name}}) still needs the secrets scope.',
    query: z.object({
      name: z.string().min(1).optional().describe('Just this key (any case), with more of the places it is used.'),
      after: z.string().min(1).optional().describe('next_after from the previous page.'),
    }),
    responses: { 404: 'No saved key has that name.' },
  }),
  op({
    method: 'get', path: '/runs', operationId: 'listRuns', tag: 'runs', scope: 'read',
    summary: 'Recent AI and HTTP runs, newest first.',
    query: z.object({
      sheet_id: z.string().optional().describe("Only this sheet's runs."),
      filter: z.enum(['active', 'terminal', 'all']).optional().describe('Default all.'),
      limit: z.number().int().min(1).max(RUN_LIST_MAX).optional().describe(`Default ${RUN_LIST_DEFAULT}.`),
    }),
    notFound: true,
  }),
  op({
    method: 'get', path: '/ai-runs/{id}', operationId: 'getAiRun', tag: 'runs', scope: 'read',
    summary: "An AI run's state, progress, cost so far and error.",
  }),
  op({
    method: 'get', path: '/http-runs/{id}', operationId: 'getHttpRun', tag: 'runs', scope: 'read',
    summary: "An HTTP, enrichment or waterfall run's state, progress, cost and error.",
  }),
  op({
    method: 'get', path: '/ai-runs/{id}/results', operationId: 'getAiRunResults', tag: 'runs', scope: 'read',
    summary: "An AI run's results and errors, row by row, a page at a time.",
    query: resultsPage,
  }),
  op({
    method: 'get', path: '/http-runs/{id}/results', operationId: 'getHttpRunResults', tag: 'runs', scope: 'read',
    summary: "An HTTP, enrichment or waterfall run's results and errors, row by row, a page at a time.",
    query: resultsPage.extend({
      answers: z.enum(['true', 'false']).optional()
        .describe("true adds each row's stored answer, 10 rows a page. Needs secrets when the request read a "
          + 'saved key.'),
    }),
    responses: { 403: 'answers=true on a run whose request read a saved key, from a token without secrets.' },
  }),
  op({
    method: 'post', path: '/sheets/{id}/run-conditions/check', operationId: 'checkRunCondition', tag: 'runs',
    scope: 'read', summary: 'Check an "Only run if" rule: how many rows pass, and the first rows with their verdict.',
    body: toolBody('check_run_condition', { omit: ['sheet_id'] }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/run-conditions/generate', operationId: 'writeRunCondition', tag: 'runs',
    scope: 'run', summary: 'Have the AI model write an "Only run if" rule from plain words, with one small call.',
    body: toolBody('write_run_condition', {
      omit: ['sheet_id', 'model'],
      extend: { model: z.string().max(200).optional().describe("OpenRouter model id. Default: the sheet's.") },
    }),
  }),
];
