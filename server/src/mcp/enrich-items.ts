import { z } from 'zod';
import { ENRICH_CALL_MAX_ITEMS } from '../lib/constants-setups';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { callEnrichment } from '../services/enrich-call';
import { McpAuthCtx, ok, err, lenientBoolean } from './tool-helpers';

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// run_enrichment's items (and REST POST /enrichments/:toolId/calls): objects keyed by the tool's input names.
export const ENRICH_ITEMS = z.array(z.record(z.string(), cell)).min(1).max(ENRICH_CALL_MAX_ITEMS)
  .describe('[{ "<tool input>": value }]');

// The run_enrichment fields that only items take, with their schemas.
export const ITEMS_FIELDS = {
  fields: z.array(z.string()).optional().describe('With items: output fields to keep (default all)'),
  max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
    .describe('With items: refuse to start when it could cost more, in dollars'),
  allow_unpriced: lenientBoolean().optional().describe('With items: run a tool with no known price'),
};
const ITEMS_ONLY = ['items', ...Object.keys(ITEMS_FIELDS)];
// What run_enrichment takes with items; every other argument goes with sheet_id.
const WITH_ITEMS = new Set(['tool_id', 'estimate_only', 'webhook_id', ...ITEMS_ONLY]);

// A run_enrichment argument that doesn't go with the other arguments sent: with items, one only a sheet takes;
// on a sheet, one only items take.
export function misplacedArgument(a: Record<string, unknown>): string | null {
  const sent = Object.keys(a).filter(k => a[k] !== undefined);
  if (a.items !== undefined) {
    if (a.sheet_id !== undefined) return 'Pass sheet_id or items, not both.';
    const sheetOnly = sent.filter(k => !WITH_ITEMS.has(k));
    return sheetOnly.length ? `${sheetOnly.join(', ')} go with sheet_id, not items. With items it takes tool_id, `
      + 'items, fields, estimate_only, max_cost_usd, allow_unpriced and webhook_id.' : null;
  }
  const itemsOnly = sent.filter(k => ITEMS_ONLY.includes(k));
  if (itemsOnly.length) {
    return `${itemsOnly.join(', ')} go with items, not sheet_id. On a sheet, spend_limit_usd caps the run and `
      + 'max_cost_per_row_usd each row.';
  }
  if (a.sheet_id === undefined) return 'Pass sheet_id (fill a sheet\'s column) or items (items without a sheet).';
  if (a.column_name === undefined) return 'column_name is needed with sheet_id: the status column.';
  return null;
}

// run_enrichment with items: one enrichment tool called on items without a sheet (services/enrich-call.ts). The
// call is an enrichment run on a working table of its own: get_run (action status) and get_run (action results) answer
// for it.
export async function runEnrichmentOnItems(ctx: McpAuthCtx, a: {
  tool_id: string; items: unknown; fields?: string[]; estimate_only?: boolean; max_cost_usd?: number;
  allow_unpriced?: boolean; webhook_id?: string;
}) {
  const out = await callEnrichment(ctx, {
    toolId: a.tool_id, items: a.items, fields: a.fields, estimateOnly: a.estimate_only !== false,
    maxCostUsd: a.max_cost_usd ?? null, allowUnpriced: !!a.allow_unpriced, webhookId: a.webhook_id ?? null,
  });
  if ('fail' in out) return err(out.message + (out.estimate ? ` Estimate: ${JSON.stringify(out.estimate)}` : ''));
  // Its working table is never a sheet the user has.
  return ok({ ...out.ok, changed: [] });
}
