// The estimate request a Set up step (or, later, an agent) sends (pure): the
// tool, how many rows, and the waterfall choices. Strict, because the numbers
// it returns are shown as money.
import {
  TREG_TOOL_ID_PATTERN, ENRICH_ESTIMATE_MAX_ROWS, ENRICH_ESTIMATE_MAX_LIST, ENRICH_MAX_ROW_CAP_USD,
  ENRICH_LIST_MAX_ITEMS, UUID_PATTERN,
} from './constants';
import type { ProviderPick } from './enrich-estimate';

// A list job: its one provider, results per row, and the sheet the rows go to
// (null: a new sheet), for "May add up to N rows".
export interface EstimateList { provider: string | null; maxItems: number; destSheetId: string | null }

export interface EstimateInput extends Required<Omit<ProviderPick, 'limit'>> {
  toolId: string; rows: number; preset: 'verified_email' | null; maxCostPerRowUsd: number | null; limit: number | null;
  list: EstimateList | null;
}

function parseList(v: unknown): EstimateList | null | undefined {
  if (v === undefined || v === null) return null;
  const l = (typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const provider = l.provider === undefined || l.provider === null ? null
    : typeof l.provider === 'string' && NAME_RE.test(l.provider) ? l.provider : undefined;
  const maxItems = l.maxItems;
  const dest = l.destSheetId === undefined || l.destSheetId === null ? null
    : typeof l.destSheetId === 'string' && UUID_PATTERN.test(l.destSheetId) ? l.destSheetId : undefined;
  if (provider === undefined || dest === undefined || typeof maxItems !== 'number' || !Number.isSafeInteger(maxItems)
    || maxItems < 1 || maxItems > ENRICH_LIST_MAX_ITEMS) return undefined;
  return { provider, maxItems, destSheetId: dest };
}

// Input names (company_domain) and provider slugs (fiber-ai).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function names(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > ENRICH_ESTIMATE_MAX_LIST) return null;
  return v.every(s => typeof s === 'string' && NAME_RE.test(s)) ? v as string[] : null;
}

export function parseEstimateInput(body: unknown): { ok: EstimateInput } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.toolId !== 'string' || !TREG_TOOL_ID_PATTERN.test(b.toolId)) return { error: 'Pick a tool first.' };
  const rows = b.rows;
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0 || rows > ENRICH_ESTIMATE_MAX_ROWS) {
    return { error: 'rows must be a whole number.' };
  }
  // No `given` at all means "don't filter by inputs" (every provider counts, the
  // safe side for a cost estimate); [] means nothing is mapped.
  const given = b.given === undefined || b.given === null ? null : names(b.given);
  const skip = names(b.skip), order = names(b.order);
  if ((b.given != null && !given) || !skip || !order) return { error: 'given, skip and order must be lists of names.' };
  const cap = b.maxCostPerRowUsd ?? null;
  if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0 || cap > ENRICH_MAX_ROW_CAP_USD)) {
    const max = ENRICH_MAX_ROW_CAP_USD.toLocaleString('en-US');
    return { error: `Max per row must be more than $0 and at most $${max}.` };
  }
  const limit = b.limit ?? null;
  if (limit !== null && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    return { error: 'limit must be 1 to 100.' };
  }
  if (b.preset !== undefined && b.preset !== null && b.preset !== 'verified_email') return { error: 'Unknown preset.' };
  const list = parseList(b.list);
  if (list === undefined) {
    return { error: `list needs a provider name and 1 to ${ENRICH_LIST_MAX_ITEMS} results per row.` };
  }
  return {
    ok: {
      toolId: b.toolId, rows, given, skip, order, stopAtFirst: b.stopAtFirst === true, maxCostPerRowUsd: cap, limit,
      preset: b.preset === 'verified_email' ? 'verified_email' : null, list,
    },
  };
}
