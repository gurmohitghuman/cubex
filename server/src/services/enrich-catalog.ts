// Finding and describing enrichment tools: the drawer's search and "Popular"
// list, the tool details for setup, and the MCP search_enrichments /
// get_enrichment tools all come through here.
import { ENRICH_FEATURED, ENRICH_SEARCH_RESULTS, type FeaturedJob } from '../lib/constants';
import { searchCatalog, getCatalogEndpoint, providerNames } from '../lib/treg-catalog';
import { summarizeTool, normalizeTool, hiddenReason, type ToolSummary, type EnrichTool } from '../lib/enrich-tool';

export type CatalogFailure = { fail: 'unreachable' | 'not_found' | 'hidden' | 'upstream'; message: string };

export interface FeaturedTool extends ToolSummary { title: string; blurb: string; preset?: FeaturedJob['preset']; addsRows: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function unreachable(): CatalogFailure {
  return { fail: 'unreachable', message: "Can't reach treg's catalog right now. Try again in a moment." };
}

// Search results: treg's own ranking, minus tools a row lookup can't use, with
// the ones that need the team's own provider key after the rest.
export async function searchTools(query: string): Promise<{ ok: ToolSummary[] } | CatalogFailure> {
  const res = await searchCatalog(query);
  if (!res.ok) return res.unreachable ? unreachable() : { fail: 'upstream', message: `treg's catalog answered ${res.status}.` };
  const names = await providerNames();
  const tools = (Array.isArray(res.body.results) ? res.body.results : [])
    .filter(isObj)
    .filter(ep => hiddenReason(ep) === null)
    .map(ep => summarizeTool(ep))
    .filter((t): t is ToolSummary => t !== null)
    .map(t => ({ ...t, providerName: names[t.provider] ?? t.provider }));
  const sorted = [...tools.filter(t => !t.needsOwnKey), ...tools.filter(t => t.needsOwnKey)];
  return { ok: sorted.slice(0, ENRICH_SEARCH_RESULTS) };
}

// One tool, ready for setup. Waterfall providers get display names.
export async function getTool(toolId: string): Promise<{ ok: EnrichTool } | CatalogFailure> {
  const res = await getCatalogEndpoint(toolId);
  if (!res.ok) {
    if (res.unreachable) return unreachable();
    if (res.status === 404) return { fail: 'not_found', message: `No tool "${toolId}" in treg's catalog.` };
    return { fail: 'upstream', message: `treg's catalog answered ${res.status}.` };
  }
  const ep = isObj(res.body.endpoint) ? res.body.endpoint : null;
  const reason = ep ? hiddenReason(ep) : 'no endpoint';
  if (reason) return { fail: 'hidden', message: `This tool can't run in a sheet (${reason}).` };
  const tool = normalizeTool(res.body);
  if (!tool) return { fail: 'not_found', message: `No tool "${toolId}" in treg's catalog.` };
  if (tool.providers) {
    const names = await providerNames();
    tool.providers = tool.providers.map(p => ({ ...p, name: names[p.provider] ?? p.provider }));
  }
  return { ok: tool };
}

// The "Popular" list. A featured id the catalog no longer has (or now hides)
// drops out instead of showing a broken card.
export async function featuredTools(): Promise<{ ok: FeaturedTool[] } | CatalogFailure> {
  const reads = await Promise.all(ENRICH_FEATURED.map(async job => ({ job, tool: await getTool(job.id) })));
  if (reads.every(r => 'fail' in r.tool && r.tool.fail === 'unreachable')) return unreachable();
  const out: FeaturedTool[] = [];
  for (const { job, tool } of reads) {
    if (!('ok' in tool)) continue;
    const t = tool.ok;
    const summary: ToolSummary = {
      id: t.id, name: t.name, summary: t.summary, provider: t.provider, kind: t.kind, capability: t.capability,
      platformLabel: t.platformLabel, price: t.price, observed: t.observed, childCount: t.childCount, needsOwnKey: t.needsOwnKey,
    };
    out.push({ ...summary, title: job.title, blurb: job.blurb, ...(job.preset ? { preset: job.preset } : {}), addsRows: t.list !== null });
  }
  return { ok: out };
}
