// The `enrichment` block an enrichment run keeps in http_runs.config (pure).
// The rest of the config is a normal HTTP config, so rename, delete, locked
// columns, placeholders, resume and SSE work unchanged: the input templates
// ({{Column}}) sit in requestConfig.body as JSON {input: template}, and the
// output columns in responseMapping. Everything a worker needs is frozen at
// start (the tool, provider names and route headers), so a run never reads
// the catalog mid-way and a resume calls exactly what the start priced.
import type { RequestTool } from './enrich-request';
import type { EmailStrategy } from './enrich-email-status';
import type { EnrichTool } from './enrich-tool';
import type { HTTPAPIConfig } from './http-request-template';

// Which rows a run takes: a scope (every row, the saved filter's rows, the
// selected rows) narrowed, on a column a run already made, by the status cell:
// empty (not enriched yet), empty or skipped or failed (without a result), or
// failed. 'any' takes every row in scope again.
export type EnrichRowsMode = 'all' | 'filter' | 'selected';
export type EnrichRowsStatus = 'any' | 'not_enriched' | 'no_result' | 'failed';
export interface EnrichCondition { column: string; op: 'not_empty' | 'empty' | 'eq' | 'neq' | 'contains' | 'gt' | 'lt'; value: string }

export interface EnrichRoute { prefer: string[]; exclude: string[]; stopAtFirst: boolean }

export interface EnrichEmailLoop {
  strategy: EmailStrategy;
  guess: boolean;
  pattern: string;
  verifyTool: RequestTool;
  verifyExclude: string[];
  verifyKind: 'waterfall' | 'single';
}

export interface EnrichmentBlock {
  v: 1;
  toolId: string;
  toolName: string;
  kind: 'waterfall' | 'single';
  preset: 'verified_email' | null;
  toolSnapshot: RequestTool;
  providerNames: Record<string, string>;
  route: EnrichRoute;
  cleanDomains: boolean;
  fresh: boolean;
  // The per-row cap sent as X-Treg-Route-Max-Cost (the email loop's budget for
  // all its calls); null for a tool with no known price, which the provider bills.
  maxCostPerRowUsd: number | null;
  spendLimitUsd: number | null;
  rows: { mode: EnrichRowsMode; status?: EnrichRowsStatus; test: number | null; where: EnrichCondition[] };
  email: EnrichEmailLoop | null;
}

export type EnrichRunConfig = HTTPAPIConfig & { enrichment: EnrichmentBlock };

export function isEnrichmentConfig(config: unknown): config is EnrichRunConfig {
  const e = (config as { enrichment?: unknown } | null)?.enrichment;
  return !!e && typeof e === 'object' && (e as { v?: unknown }).v === 1;
}

// The input templates, {input name: "{{Column}}" or a fixed value}.
export function inputTemplates(config: HTTPAPIConfig): Record<string, string> {
  try {
    const parsed = JSON.parse(config.requestConfig.body ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch { return {}; }
}

export function requestToolOf(tool: EnrichTool): RequestTool {
  return {
    id: tool.id, method: tool.method, inputs: tool.inputs, identitySets: tool.identitySets,
    derive: tool.derive, queryArrayEncoding: tool.queryArrayEncoding,
  };
}

// Route headers for a waterfall. Exclude is per provider: a provider is left
// out when none of its endpoints can run (switched off, answers later such as
// wiza's async finders, or retired), so treg never calls it. Prefer is the
// user's order of the providers left on.
export function routeFor(tool: EnrichTool, order: string[], skip: string[], stopAtFirst: boolean): EnrichRoute {
  if (tool.kind !== 'waterfall' || !tool.providers) return { prefer: [], exclude: [], stopAtFirst: false };
  const off = new Set(skip.map(s => s.toLowerCase()));
  const all = new Set(tool.providers.map(p => p.provider.toLowerCase()));
  const on = new Set(tool.providers.filter(p => !p.unavailable && !off.has(p.provider.toLowerCase())).map(p => p.provider.toLowerCase()));
  const exclude = [...all].filter(p => !on.has(p)).sort();
  const prefer = [...new Set(order.map(s => s.toLowerCase()))].filter(p => on.has(p));
  return { prefer, exclude, stopAtFirst };
}

export function providerNamesOf(...tools: EnrichTool[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tools) for (const p of t.providers ?? []) if (p.name) out[p.provider.toLowerCase()] = p.name;
  return out;
}

// Paths Cubex fills itself (not treg's answer): "Found by" as a display name,
// and the email loop's verdicts.
export const CUBEX_PATHS = {
  found_by: '$._cubex.found_by',
  email: '$._cubex.email',
  email_status: '$._cubex.email_status',
  checked_by: '$._cubex.checked_by',
} as const;
