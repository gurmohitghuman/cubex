// /api/v1 routes: clean, formula and lookup columns, enrichments, waterfalls
// and AI visibility tables (api-v1-clean.ts, api-v1-formula.ts, api-v1-lookup.ts,
// api-v1-enrich.ts, api-v1-waterfall.ts, api-v1-ai-visibility.ts).
import { z } from 'zod';
import {
  AI_VISIBILITY_MAX_BRAND_CHARS, AI_VISIBILITY_MAX_COMPETITORS, AI_VISIBILITY_MAX_QUESTIONS,
} from '../lib/constants-ai-visibility';
import { ENGINES } from '../lib/ai-visibility/engines';
import { op, type RouteDoc } from './route-doc';
import { toolBody } from './tool-schemas';
import { OPENROUTER_BALANCE_CACHE_MS } from '../lib/constants';

const idempotency = z.object({
  'Idempotency-Key': z.string().max(200).optional()
    .describe('Or idempotency_key in the body. A retry with the same key and arguments replays the first start.'),
});
const started = {
  202: 'Started: the run_id to poll at GET /http-runs/{id}.',
  200: 'An estimate, or a retry that replayed an earlier start.',
};
const filled = { 201: 'A new column.', 200: 'A changed column, or a preview.' };
const brand = z.string().max(AI_VISIBILITY_MAX_BRAND_CHARS).describe('Your brand, as answers would name it.');
const otherBrands = z.array(z.string().max(AI_VISIBILITY_MAX_BRAND_CHARS)).max(AI_VISIBILITY_MAX_COMPETITORS)
  .describe('Competitors to look for in the answers.');

export const fillRoutes = (): RouteDoc[] => [
  op({
    method: 'post', path: '/sheets/{id}/clean-columns', operationId: 'cleanColumn', tag: 'filled', scope: 'write',
    summary: 'Clean a column into a new column for free: names, companies, emails, domains, phones, case, spaces, '
      + 'garbled characters.',
    body: toolBody('clean_column', { omit: ['sheet_id'], strict: true }), responses: filled,
  }),
  op({
    method: 'post', path: '/sheets/{id}/formula-columns', operationId: 'formulaColumn', tag: 'filled',
    scope: 'write', summary: 'Fill a column for free with a JavaScript formula worked out from each row.',
    body: toolBody('formula_column', { omit: ['sheet_id'], strict: true }), responses: filled,
  }),
  op({
    method: 'post', path: '/sheets/{id}/formula-columns/write', operationId: 'writeFormula', tag: 'filled',
    scope: 'run', summary: 'Have the AI model write a formula from plain words. Nothing is saved.',
    description: "One small call to the sheet's model, which costs money.",
    body: toolBody('write_formula', { omit: ['sheet_id'] }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/lookup-columns', operationId: 'lookupColumn', tag: 'filled',
    scope: 'write', summary: 'Fill a column for free from another sheet, by matching a column against it.',
    body: toolBody('lookup_column', { omit: ['sheet_id'], strict: true }), responses: filled,
  }),
  op({
    method: 'get', path: '/balances', operationId: 'getBalances', tag: 'enrich', scope: 'read',
    summary: 'The treg balance, the daily enrichment limit, and what OpenRouter reports for the saved key.',
    description: "As MCP's get_balances. openrouter.checked_at is when Cubex read OpenRouter's numbers (a read is "
      + `reused for ${OPENROUTER_BALANCE_CACHE_MS / 1000} seconds); they can lag behind runs that just finished, `
      + 'while access_token.spent_usd is live.',
  }),
  op({
    method: 'get', path: '/enrichments', operationId: 'searchEnrichments', tag: 'enrich', scope: 'read',
    summary: "Search treg's enrichment catalog. Without q, the popular jobs.",
    query: z.object({ q: z.string().optional().describe('What to find, such as work email. Cut to 200 characters.') }),
    responses: { 502: "The catalog couldn't be reached." },
  }),
  op({
    method: 'get', path: '/enrichments/{toolId}', operationId: 'getEnrichment', tag: 'enrich', scope: 'read',
    summary: "An enrichment tool's inputs, outputs, price and providers.",
    responses: { 422: "A tool Cubex doesn't offer.", 502: "The catalog couldn't be reached." },
  }),
  op({
    method: 'post', path: '/sheets/{id}/enrichment-runs', operationId: 'startEnrichmentRun', tag: 'enrich',
    scope: 'run', summary: 'Run a treg enrichment once per row. Each row is a paid call: estimate first.',
    headers: idempotency,
    body: toolBody('run_enrichment', { omit: ['sheet_id'], strict: true }), responses: started,
  }),
  op({
    method: 'post', path: '/sheets/{id}/enrichment-fields', operationId: 'addEnrichmentField', tag: 'enrich',
    scope: 'write', summary: "Add a column from an enrichment's stored answers. It fills in the background.",
    body: toolBody('add_enrichment_field', { omit: ['sheet_id'], strict: true }),
    responses: { 202: 'The column is filling.' },
  }),
  op({
    method: 'get', path: '/sheets/{id}/enrichment-list-fields', operationId: 'getListFields', tag: 'enrich',
    scope: 'read', summary: "The fields a list job's results have, to pick the columns its rows get.",
    query: z.object({ column: z.string().describe('The column of the list job.') }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/enrichment-list-fields', operationId: 'addListRows', tag: 'enrich',
    scope: 'write', summary: "Add a list job's waiting results as rows, with the fields picked.",
    body: toolBody('add_list_rows', { omit: ['sheet_id'], strict: true }),
  }),
  op({
    method: 'put', path: '/sheets/{id}/enrichment-auto-run', operationId: 'setAutoRun', tag: 'enrich',
    scope: 'run', summary: "Turn a column's auto-run on or off, or pause or resume every auto-run on the sheet.",
    body: toolBody('set_auto_run', { omit: ['sheet_id'], strict: true }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/waterfall-columns', operationId: 'startWaterfall', tag: 'enrich',
    scope: 'run', summary: 'Fill one value per row from ordered steps, stopping at the first answer.',
    description: "Same as MCP's waterfall_column, but estimate_only defaults to false here.",
    headers: idempotency,
    body: toolBody('waterfall_column', {
      omit: ['sheet_id', 'action', 'estimate_only'], strict: true,
      extend: {
        action: z.literal('run').optional()
          .describe('Only run here. Read a setup with GET .../waterfall-columns/{column}.'),
        estimate_only: z.boolean().optional().describe('true prices it and creates nothing. Default false here.'),
      },
    }),
    responses: started,
  }),
  op({
    method: 'get', path: '/sheets/{id}/waterfall-columns/{column}', operationId: 'getWaterfall', tag: 'enrich',
    scope: 'read', summary: "A waterfall column's setup, step ids included, in the shape the start takes.",
  }),
  op({
    method: 'post', path: '/ai-visibility', operationId: 'createAiVisibility', tag: 'visibility', scope: 'write',
    summary: 'Make a table that asks AI engines the questions buyers ask, and finds who they name.',
    description: 'Nothing is asked yet: ask starts that.',
    body: z.object({
      brand,
      other_brands: otherBrands.optional(),
      domain: z.string().optional().describe('Your site (acme.com), to mark the sources on it.'),
      country: z.string().length(2).optional().describe('Where the questions are asked from. Default US.'),
      engines: z.array(z.enum(ENGINES.map(e => e.id) as [string, ...string[]])).min(1).optional()
        .describe(`Default: ${ENGINES.filter(e => e.defaultOn).map(e => e.id).join(', ')}.`),
      questions: z.array(z.string())
        .describe(`The questions, as a buyer asks them. At most ${AI_VISIBILITY_MAX_QUESTIONS}.`),
    }),
    responses: { 201: 'The new table.' },
  }),
  op({
    method: 'post', path: '/ai-visibility/{id}/ask', operationId: 'askAiVisibility', tag: 'visibility',
    scope: 'run', summary: "Ask every engine the table's questions. Paid: estimate first.",
    body: z.object({
      estimate_only: z.boolean().optional().describe('true answers the cost and starts nothing. Default false.'),
      again: z.boolean().optional().describe('true asks every question again, not only those not asked yet.'),
    }),
  }),
  op({
    method: 'post', path: '/ai-visibility/{id}/check-again', operationId: 'checkAiVisibilityAgain',
    tag: 'visibility', scope: 'run',
    summary: 'Keep the answers in dated sheets, add the comparison columns, and ask every question again.',
    description: 'An estimate unless estimate_only is false.',
    body: z.object({
      estimate_only: z.boolean().optional().describe('false checks for real. Default true: the plan and its cost.'),
      time_zone: z.string().optional().describe("The user's IANA time zone, for the day in the names. Default UTC."),
      fresh: z.boolean().optional().describe('true starts a new check rather than picking up one that stopped.'),
    }),
  }),
  op({
    method: 'put', path: '/ai-visibility/{id}/brands', operationId: 'setAiVisibilityBrands', tag: 'visibility',
    scope: 'write', summary: 'Change the brands the table looks for. The formulas are rewritten; nothing is asked.',
    body: z.object({
      brand: brand.optional().describe('Your brand. Left out, it stays.'),
      other_brands: otherBrands.optional().describe('Replaces the list of competitors. Left out, it stays.'),
    }),
  }),
];
