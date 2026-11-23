// Provider name checks against treg's catalog (pure): a misspelled provider in
// providerOrder/skipProviders (or provider_order/skip_providers) is refused
// with the names the tool knows, instead of being dropped silently (a mistyped
// skip would otherwise let that provider run and charge). Names already stored
// on a saved column keep working if treg drops a provider later, and are
// reported so the caller knows which old name was ignored.
import type { EnrichTool } from './enrich-tool';

export interface SavedProviderNames {
  order?: Iterable<string>;
  skip?: Iterable<string>;
}

export interface CheckedProviders {
  error: string | null;
  ignored: string[];
}

// Unique lowercased provider slugs a waterfall tool (or tools) knows, sorted.
export function knownProviderNames(...tools: EnrichTool[]): string[] {
  const names = new Set<string>();
  for (const t of tools) {
    if (t.kind !== 'waterfall' || !t.providers) continue;
    for (const p of t.providers) names.add(p.provider.toLowerCase());
  }
  return [...names].sort();
}

const quoteList = (names: string[]): string => names.map(n => `"${n}"`).join(', ');
const lead = (where: string | undefined, text: string): string =>
  (where ? `${where}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1));

export function checkProviderList(opts: {
  where?: string;
  field: string;
  given: string[];
  tools: EnrichTool[];
  allowed?: Iterable<string>;
}): CheckedProviders {
  const { where, field, given, tools, allowed } = opts;
  if (given.length === 0) return { error: null, ignored: [] };
  // A waterfall whose routing plan the catalog didn't list has no known list to check against.
  if (tools.some(t => t.kind === 'waterfall' && t.providers === null)) return { error: null, ignored: [] };
  const known = knownProviderNames(...tools);
  const knownSet = new Set(known);
  const allowedSet = new Set([...(allowed ?? [])].map(s => s.toLowerCase()));
  const seenBad = new Set<string>();
  const seenIgnored = new Set<string>();
  const unknown: string[] = [];
  const ignored: string[] = [];
  for (const raw of given) {
    const lower = raw.toLowerCase();
    if (knownSet.has(lower)) continue;
    if (allowedSet.has(lower)) {
      if (!seenIgnored.has(lower)) { seenIgnored.add(lower); ignored.push(raw); }
    } else if (!seenBad.has(lower)) {
      seenBad.add(lower); unknown.push(raw);
    }
  }
  if (unknown.length > 0) {
    if (known.length === 0) {
      const only = tools[0];
      return {
        error: lead(where, `${field} applies only to tools with multiple providers `
          + `(${only.id} uses ${only.provider} only).`),
        ignored: [],
      };
    }
    const noun = unknown.length === 1 ? 'provider' : 'providers';
    return {
      error: lead(where, `unknown ${noun} ${quoteList(unknown)} in ${field}. Known providers: ${known.join(', ')}.`),
      ignored: [],
    };
  }
  if (ignored.length > 0) {
    const noun = ignored.length === 1 ? 'provider' : 'providers';
    return {
      error: null,
      ignored: [lead(where, `ignored unknown ${noun} ${quoteList(ignored)} in ${field} `
        + "(no longer in treg's catalog).")],
    };
  }
  return { error: null, ignored: [] };
}

export function checkStepProviders(opts: {
  where?: string;
  order: string[];
  skip: string[];
  orderTools: EnrichTool[];
  skipTools?: EnrichTool[];
  saved?: SavedProviderNames;
  orderField?: string;
  skipField?: string;
}): CheckedProviders {
  const orderRes = checkProviderList({
    where: opts.where, field: opts.orderField ?? 'providerOrder', given: opts.order,
    tools: opts.orderTools, allowed: opts.saved?.order,
  });
  if (orderRes.error) return orderRes;
  const skipRes = checkProviderList({
    where: opts.where, field: opts.skipField ?? 'skipProviders', given: opts.skip,
    tools: opts.skipTools ?? opts.orderTools, allowed: opts.saved?.skip,
  });
  if (skipRes.error) return skipRes;
  return { error: null, ignored: [...orderRes.ignored, ...skipRes.ignored] };
}

// Token surfaces (/api/v1 and MCP) use snake_case field names.
export const snakeProviderField = (text: string): string =>
  text.replace(/\bproviderOrder\b/g, 'provider_order').replace(/\bskipProviders\b/g, 'skip_providers');
