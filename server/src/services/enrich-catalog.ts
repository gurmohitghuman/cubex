// Finding and describing enrichment tools: the drawer's search and "Popular"
// list, the tool details for setup, and the MCP search_enrichments /
// get_enrichment tools all come through here.
import { ENRICH_FEATURED, ENRICH_SEARCH_RESULTS, type FeaturedJob } from '../lib/constants';
import { searchCatalog, getCatalogEndpoint, providerNames } from '../lib/treg-catalog';
import { summarizeTool, normalizeTool, hiddenReason, type ToolSummary, type EnrichTool } from '../lib/enrich-tool';
import { plainText, toolTitle } from '../lib/enrich-tool-label';
import { jobMatches } from '../lib/enrich-job-match';

export type CatalogFailure = { fail: 'unreachable' | 'not_found' | 'hidden' | 'upstream'; message: string };

// A tool as a card: its title, a one-line blurb (Popular jobs only), the
// preset it opens with, and whether it adds its results as rows.
export interface ListedTool extends ToolSummary {
  title: string; blurb: string; preset?: FeaturedJob['preset']; addsRows: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const FEATURED = new Map(ENRICH_FEATURED.map(job => [job.id, job]));

function unreachable(): CatalogFailure {
  return { fail: 'unreachable', message: "Can't reach treg's catalog right now. Try again in a moment." };
}

function listed(t: ToolSummary, addsRows: boolean): ListedTool {
  const job = FEATURED.get(t.id);
  return {
    ...t, summary: plainText(t.summary), title: toolTitle(t, job?.title), blurb: job?.blurb ?? '',
    ...(job?.preset ? { preset: job.preset } : {}), addsRows,
  };
}

// Jobs whose waterfall contract answers with a list (people, companies…): any
// tool for them adds its results as rows in another sheet. treg lists a job's
// waterfall with any of its providers that match, so reading the waterfalls in
// the results is enough (their details are cached).
async function listJobs(tools: ToolSummary[]): Promise<Set<string>> {
  const waterfalls = tools.filter(t => t.kind === 'waterfall' && t.capability);
  const reads = await Promise.all(waterfalls.map(async t => ({ t, tool: await getTool(t.id) })));
  return new Set(reads.filter(r => 'ok' in r.tool && r.tool.ok.list).map(r => r.t.capability as string));
}

// Search results: the Popular jobs the words match, then treg's own ranking,
// minus tools a row lookup can't use, with the ones that need the team's own
// provider key after the rest.
export async function searchTools(query: string): Promise<{ ok: ListedTool[] } | CatalogFailure> {
  const res = await searchCatalog(query);
  if (!res.ok) {
    return res.unreachable ? unreachable() : { fail: 'upstream', message: `treg's catalog answered ${res.status}.` };
  }
  const names = await providerNames();
  const jobs = ENRICH_FEATURED.filter(job => jobMatches(job.title, query));
  const lead = (await Promise.all(jobs.map(job => getTool(job.id)))).flatMap(r => ('ok' in r ? [r.ok] : []));
  const leadIds = new Set(lead.map(t => t.id));
  const tools = (Array.isArray(res.body.results) ? res.body.results : [])
    .filter(isObj)
    .filter(ep => hiddenReason(ep) === null)
    .map(ep => summarizeTool(ep))
    .filter((t): t is ToolSummary => t !== null && !leadIds.has(t.id))
    .map(t => ({ ...t, providerName: t.providerName ?? names[t.provider] ?? t.provider }));
  const sorted = [...tools.filter(t => !t.needsOwnKey), ...tools.filter(t => t.needsOwnKey)]
    .slice(0, Math.max(0, ENRICH_SEARCH_RESULTS - lead.length));
  const lists = await listJobs(sorted);
  for (const t of lead) if (t.list && t.capability) lists.add(t.capability);
  return {
    ok: [
      ...lead.map(t => listed(summaryOf(t), t.list !== null)),
      ...sorted.map(t => listed(t, lists.has(t.capability ?? ''))),
    ],
  };
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

// Whether a tool adds its results as rows: a waterfall whose contract answers
// with a list, or a single tool of such a job (treg lists the job's waterfall,
// treg.<capability>, among the tool's siblings) whose example has a list.
export async function addsRows(tool: EnrichTool): Promise<boolean> {
  if (!tool.list) return false;
  if (tool.kind === 'waterfall') return true;
  if (!tool.waterfallId) return false;
  const job = await getTool(tool.waterfallId);
  return 'ok' in job && job.ok.kind === 'waterfall' && job.ok.list !== null;
}

function summaryOf(t: EnrichTool): ToolSummary {
  return {
    id: t.id, name: t.name, summary: t.summary, provider: t.provider,
    ...(t.providerName ? { providerName: t.providerName } : {}),
    kind: t.kind, capability: t.capability, capabilityDescription: t.capabilityDescription,
    platformLabel: t.platformLabel,
    price: t.price, observed: t.observed, childCount: t.childCount, needsOwnKey: t.needsOwnKey,
  };
}

// The "Popular" list. A featured id the catalog no longer has (or now hides)
// drops out instead of showing a broken card.
export async function featuredTools(): Promise<{ ok: ListedTool[] } | CatalogFailure> {
  const reads = await Promise.all(ENRICH_FEATURED.map(job => getTool(job.id)));
  if (reads.every(r => 'fail' in r && r.fail === 'unreachable')) return unreachable();
  return { ok: reads.flatMap(r => ('ok' in r ? [listed(summaryOf(r.ok), r.ok.list !== null)] : [])) };
}

// One tool as the drawer's card, for "Edit enrichment" (a column's tool opened
// straight at Set up). The preset comes from the column's run, not from the
// Popular list, so an email finder run without the preset reopens without it.
export async function toolCard(
  toolId: string, preset: FeaturedJob['preset'] | null,
): Promise<{ ok: ListedTool } | CatalogFailure> {
  const found = await getTool(toolId);
  if (!('ok' in found)) return found;
  const t = summaryOf(found.ok);
  const job = ENRICH_FEATURED.find(j => j.id === toolId && (j.preset ?? null) === preset);
  return {
    ok: {
      ...t, summary: plainText(t.summary), title: toolTitle(t, job?.title), blurb: job?.blurb ?? '',
      ...(preset ? { preset } : {}), addsRows: await addsRows(found.ok),
    },
  };
}
