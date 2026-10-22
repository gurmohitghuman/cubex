// treg's catalog as the agent surfaces show it (MCP search_enrichments and
// get_enrichment, GET /api/v1/enrichments[/:toolId]): the drawer's search and
// tool details (services/enrich-catalog.ts) in snake_case, with only what an
// agent needs to set up run_enrichment. Pure reads; the access read (how the
// user's treg team is served per provider) is free at treg and best effort.
import { searchTools, getTool, featuredTools, addsRows, type ListedTool, type CatalogFailure } from './enrich-catalog';
import { toolAccess } from './enrich-access';
import { getTregToken } from './treg-key';
import { FOUND_BY_FIELD, outputFields } from '../lib/enrich-agent-input';
import type { EnrichTool, ToolPrice, ToolProvider } from '../lib/enrich-tool';
import type { ToolAccess } from '../lib/treg';

const priceJson = (p: ToolPrice) => ({
  usd: p.usd, type: p.type, unit: p.unit, varies: p.varies, overflow_usd: p.overflowUsd,
});

function listedJson(t: ListedTool) {
  return {
    tool_id: t.id, title: t.title, summary: t.blurb || t.summary, kind: t.kind,
    provider: t.kind === 'single' ? t.providerName ?? t.provider : null,
    providers: t.childCount, price: priceJson(t.price), adds_rows: t.addsRows,
    needs_own_key: t.needsOwnKey, ...(t.preset ? { preset: t.preset } : {}),
  };
}

export async function agentSearchTools(query: string): Promise<{ ok: object } | CatalogFailure> {
  const q = query.trim();
  const found = q ? await searchTools(q) : await featuredTools();
  if (!('ok' in found)) return found;
  return { ok: { popular: !q, tools: found.ok.map(listedJson) } };
}

// How the team is served by each provider: its own key, a free route, or
// treg's key; null when treg's plan doesn't say. From treg's /access plan
// rows, as the drawer reads them.
function accessByProvider(access: ToolAccess | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of (access?.plan ?? []) as Array<Record<string, unknown>>) {
    const provider = typeof row.provider === 'string' ? row.provider.toLowerCase() : null;
    if (!provider || out.has(provider)) continue;
    if (row.tier === 'anonymous') out.set(provider, 'free');
    else if (row.tier === 'platform') out.set(provider, 'treg');
    else if (row.tier === 'tool' || row.tier === 'credential') {
      const billed = row.metered === true || (typeof row.price_micro === 'number' && row.price_micro > 0);
      out.set(provider, billed ? 'your_connection_metered' : 'your_key');
    }
  }
  return out;
}

function providersJson(providers: ToolProvider[], access: ToolAccess | null) {
  const tiers = accessByProvider(access);
  const groups = new Map<string, ToolProvider[]>();
  for (const p of providers) groups.set(p.provider.toLowerCase(), [...(groups.get(p.provider.toLowerCase()) ?? []), p]);
  return [...groups.entries()].map(([key, eps]) => {
    const runnable = eps.filter(e => !e.unavailable);
    const prices = runnable.map(e => e.usd).filter((n): n is number => n !== null);
    return {
      provider: key, name: eps[0].name ?? eps[0].provider,
      price_usd: prices.length ? Math.min(...prices) : null,
      hit_rate: runnable.reduce<number | null>((m, e) => (e.hitRate === null ? m : Math.max(m ?? 0, e.hitRate)), null),
      accepts: [...new Set(runnable.flatMap(e => e.accepts.map(a => a.join(' + '))))],
      unavailable: runnable.length ? null : eps[0].unavailable,
      exhausted: runnable.length > 0 && runnable.every(e => e.exhausted),
      access: tiers.get(key) ?? null,
    };
  });
}

// A single tool's lists besides its listed results.
const otherLists = (t: EnrichTool) => t.arrays.filter(p => p !== t.list?.path);

// The outputs a row can fill: for a job that adds rows, the ones outside its results.
const rowOutputs = (t: EnrichTool, listsRows: boolean) => (listsRows && t.list
  ? t.outputs.filter(o => o.path !== t.list!.path && !o.path.startsWith(`${t.list!.path}[`)) : t.outputs);

function toolJson(t: EnrichTool, listsRows: boolean, access: ToolAccess | null, hasKey: boolean) {
  const email = t.capability === 'people.email.find' && t.kind === 'waterfall';
  return {
    tool_id: t.id, name: t.name, summary: t.summary, kind: t.kind, capability: t.capability,
    provider: t.kind === 'single' ? t.providerName ?? t.provider : null,
    price: priceJson(t.price), needs_own_key: t.needsOwnKey,
    inputs: t.inputs.map(i => ({
      name: i.name, type: i.type, required: i.required, ...(i.filter ? { filter: true } : {}),
      ...(i.note ? { note: i.note } : {}), ...(i.example !== undefined ? { example: i.example } : {}),
      ...(i.enum ? { enum: i.enum } : {}), ...(i.min !== undefined ? { min: i.min } : {}),
      ...(i.max !== undefined ? { max: i.max } : {}),
    })),
    identity_sets: t.identitySets,
    // A job that adds rows: the fields outside its results, which may also fill this sheet's columns.
    outputs: rowOutputs(t, listsRows).map(o => ({
      field: o.field, path: o.path, ...(o.type ? { type: o.type } : {}), ...(o.note ? { note: o.note } : {}),
      ...(o.required ? { always_filled: true } : {}),
    })),
    output_fields: outputFields(t, null)
      .filter(f => !listsRows || f === FOUND_BY_FIELD || rowOutputs(t, true).some(o => o.field === f)),
    adds_rows: listsRows,
    ...(listsRows && t.list ? { results_at: t.list.path } : {}),
    // Its example's other lists (some shown empty): a run may name one as its results (list.items_path).
    ...(t.kind === 'single' && otherLists(t).length ? { other_lists: otherLists(t) } : {}),
    providers: t.providers ? providersJson(t.providers, access) : null,
    ...(email ? {
      presets: [{
        preset: 'verified_email', title: 'Verified work email', output_fields: outputFields(t, 'verified_email'),
        default_outputs: ['email', 'email_status', 'found_by'],
      }],
    } : {}),
    has_treg_key: hasKey,
  };
}

export async function agentGetTool(userId: string, toolId: string): Promise<{ ok: object } | CatalogFailure> {
  const found = await getTool(toolId);
  if (!('ok' in found)) return found;
  const hasKey = !!getTregToken(userId);
  const access = hasKey ? await toolAccess(userId, toolId) : null;
  return {
    ok: toolJson(found.ok, await addsRows(found.ok), access && 'ok' in access ? access.ok : null, hasKey),
  };
}
