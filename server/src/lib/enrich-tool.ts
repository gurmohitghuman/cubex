// A treg catalog entry as Cubex's enrichment tool (pure): what the drawer,
// the MCP tools and the run builder read. Hides tools a spreadsheet run can't
// use and marks the ones treg can't serve on its own key.
import {
  toolInputs, identitySetsOf, deriveOf, contractOutputs, exampleOutputs,
  type ToolInput, type ToolOutput, type ToolList,
} from './enrich-tool-io';

export type { ToolInput, ToolOutput, ToolList };

export interface ToolPrice {
  type: string | null; unit: string | null; usd: number | null; varies: boolean; note?: string;
  overflowUsd: number | null;
}
export interface ToolProvider {
  endpointId: string; provider: string; name?: string; usd: number | null; hitRate: number | null;
  usdPerHit: number | null; works: number | null; accepts: string[][]; exhausted: boolean;
  // A child a sheet run can't use: it answers later (async) or treg retired it.
  unavailable: 'async' | 'retired' | null;
}
export interface ToolObserved {
  okRate: number | null; hitRate: number | null; samples: number | null; hitSamples: number | null;
}

export interface ToolSummary {
  id: string; name: string; summary: string; provider: string; providerName?: string;
  kind: 'waterfall' | 'single'; capability: string | null; capabilityDescription: string | null;
  platformLabel: string | null; price: ToolPrice; observed: ToolObserved; childCount: number | null;
  needsOwnKey: boolean;
}

export interface EnrichTool extends ToolSummary {
  method: string; inputs: ToolInput[]; identitySets: string[][] | null; derive: Record<string, string> | null;
  outputs: ToolOutput[]; list: ToolList | null; providers: ToolProvider[] | null;
  strictQuery: boolean; bodyType: string | null; queryArrayEncoding: string | null;
  // A single tool's job waterfall (treg.<capability>), when treg lists it among
  // the tool's siblings: whether the job answers with a list is read from it.
  waterfallId: string | null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Kinds a per-row lookup can't use: actions (they change things), account and
// hub tools (OAuth or maker runs), utility plumbing (status polls and the like).
const HIDDEN_KINDS = new Set(['action', 'account', 'utility', 'hub']);
// Generated media arrives as large base64 or binary, not row data.
const MEDIA_PLATFORMS = new Set(['video-gen', 'image-gen', 'voice-gen', 'music-gen']);

export function hiddenReason(ep: Json): string | null {
  if (ep.async) return 'answers later (async)';
  if (ep.status || ep.superseded_by) return 'retired or broken';
  const kind = str(ep.kind) ?? 'data';
  if (HIDDEN_KINDS.has(kind)) return `kind ${kind}`;
  const bodyType = isObj(ep.input) ? str(ep.input.bodyType) : null;
  if (bodyType && bodyType !== 'json') return `${bodyType} body`;
  if (MEDIA_PLATFORMS.has(str(ep.platform) ?? '')) return 'media generation';
  return null;
}

function priceOf(ep: Json): ToolPrice {
  const c = isObj(ep.cost) ? ep.cost : {};
  return {
    type: str(c.type), unit: str(c.unit), usd: numOrNull(c.usd), varies: c.varies === true,
    ...(str(c.note) ? { note: str(c.note) as string } : {}),
    overflowUsd: numOrNull(ep.overflow_price_usd),
  };
}

function observedOf(ep: Json): ToolObserved {
  const o = isObj(ep.observed) ? ep.observed : {};
  return {
    okRate: numOrNull(o.ok_rate), hitRate: numOrNull(o.hit_rate), samples: numOrNull(o.samples),
    hitSamples: numOrNull(o.hit_samples),
  };
}

// treg serves a tool on its own key only with a known price and when it's
// platform-eligible; otherwise the team needs its own provider key.
function needsOwnKey(ep: Json, price: ToolPrice): boolean {
  if (ep.platform_eligible === false || ep.platform_blocked) return true;
  return price.usd === null && price.type !== 'free';
}

// childCount is the waterfall's own provider list. (A search row's
// children_hidden counts other search rows treg cut from the page, not more
// providers.)
export function summarizeTool(ep: Json): ToolSummary | null {
  const id = str(ep.id);
  if (!id) return null;
  const price = priceOf(ep);
  const waterfall = str(ep.kind) === 'routed';
  const providerName = str(ep.provider_display);
  return {
    id, name: str(ep.name) ?? id, summary: str(ep.summary) ?? '', provider: str(ep.provider) ?? id.split('.')[0],
    ...(providerName ? { providerName } : {}),
    kind: waterfall ? 'waterfall' : 'single', capability: str(ep.capability),
    capabilityDescription: str(ep.capability_description), platformLabel: str(ep.platform_label),
    price, observed: observedOf(ep),
    childCount: waterfall ? (Array.isArray(ep.routed_children) ? ep.routed_children.length : 0) : null,
    needsOwnKey: needsOwnKey(ep, price),
  };
}

// The detail's siblings (the same job's endpoints) say which children answer
// later or are retired; a run skips those.
function unavailableChildren(siblings: unknown): Map<string, 'async' | 'retired'> {
  const out = new Map<string, 'async' | 'retired'>();
  if (!Array.isArray(siblings)) return out;
  for (const s of siblings.filter(isObj)) {
    const id = str(s.id);
    if (id && s.async) out.set(id, 'async');
    else if (id && s.retired) out.set(id, 'retired');
  }
  return out;
}

function providersOf(routing: Json, siblings: unknown): ToolProvider[] | null {
  if (!Array.isArray(routing.plan)) return null;
  const off = unavailableChildren(siblings);
  return routing.plan.filter(isObj).map(p => {
    const endpointId = str(p.endpoint_id) ?? '';
    return {
      endpointId, provider: endpointId.split('.')[0], usd: numOrNull(p.usd), hitRate: numOrNull(p.hit_rate),
      usdPerHit: numOrNull(p.usd_per_hit), works: numOrNull(p.works),
      accepts: Array.isArray(p.accepts)
        ? p.accepts.filter(Array.isArray).map(a => a.filter((k: unknown): k is string => typeof k === 'string')) : [],
      exhausted: p.exhausted === true, unavailable: off.get(endpointId) ?? null,
    };
  }).filter(p => p.endpointId);
}

function waterfallIdOf(summary: ToolSummary, siblings: unknown): string | null {
  if (summary.kind === 'waterfall' || !summary.capability || !Array.isArray(siblings)) return null;
  const id = `treg.${summary.capability}`;
  return siblings.some(s => isObj(s) && s.id === id) ? id : null;
}

// /catalog/endpoints/{id} body → tool, or null when it has no usable id.
export function normalizeTool(detail: Json): EnrichTool | null {
  const ep = isObj(detail.endpoint) ? detail.endpoint : null;
  const summary = ep ? summarizeTool(ep) : null;
  if (!ep || !summary) return null;
  const routing = isObj(detail.routing) ? detail.routing : null;
  const identitySets = routing ? identitySetsOf(routing.contract) : null;
  const io = routing ? contractOutputs(routing.contract) : exampleOutputs(detail.example_response);
  const input = isObj(ep.input) ? ep.input : {};
  return {
    ...summary,
    method: (str(ep.method) ?? 'GET').toUpperCase(),
    inputs: toolInputs(input, identitySets),
    identitySets,
    derive: routing ? deriveOf(routing.contract) : null,
    outputs: io.outputs,
    list: io.list,
    providers: routing ? providersOf(routing, detail.siblings) : null,
    strictQuery: ep.strict_query === true,
    bodyType: str(input.bodyType),
    queryArrayEncoding: str(input.queryArrayEncoding),
    waterfallId: waterfallIdOf(summary, detail.siblings),
  };
}
