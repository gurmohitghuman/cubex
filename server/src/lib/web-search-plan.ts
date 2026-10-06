// Which engine a run's web searches really go to, what each one costs, and
// whether a per-row cap holds. Worked out once when a run, preview or estimate
// starts, so all three agree; a run stores the outcome (ai_runs.web_search_*)
// and its rows send exactly that. Pure: the caller supplies the catalog view
// (services/web-search-catalog.ts).
//
// The rules, from OpenRouter's web search docs (2026-10):
//   - 'auto' uses the model's own search when it has one, else Exa;
//     'native' does the same but is the explicit choice.
//   - max_uses (our cap) is enforced by OpenRouter on its own engines (Exa,
//     Parallel, Perplexity); a model's own search gets it only from Anthropic.
//   - So a cap with 'auto' on any other provider's model would not hold:
//     Cubex switches that run to Exa and says so. With an explicit 'native'
//     the run is refused instead, since switching would override the choice.
import {
  DEFAULT_SEARCH_MODE, engineLabel, hasModes, type SearchEngine, type SearchEngineUsed, type SearchOptions,
} from './web-search-options';
import {
  enginePrice, formatSearchUsd, nativeSearchProvider, type BilledEngine, type EnginePrices,
} from './web-search-pricing';

export interface SearchCatalogView {
  prices: EnginePrices;
  // Model ids whose provider runs web search itself; null when the catalog
  // couldn't be read (NATIVE_FALLBACK decides then).
  nativeModels: Set<string> | null;
}

// The models OpenRouter's docs list with their own search, for when the
// catalog is unreachable.
const NATIVE_FALLBACK = [
  /^openai\/(gpt-4\.1|gpt-5|gpt-6|o3|o4|gpt-chat)/,
  /^anthropic\/claude-(3\.5-haiku|3\.7|(opus|sonnet|haiku|fable)-[4-9]|[4-9])/,
  /^google\/gemini-[3-9]/,
  /^x-ai\/grok-[4-9]/,
  /^perplexity\//,
];

export interface SearchPlan {
  engine: SearchEngine;           // sent as the tool's engine
  used: SearchEngineUsed;         // runs the searches (and sets the price)
  mode: string | null;            // sent as the tool's mode; null: the engine's default
  maxPerRow: number | null;
  nativeProvider: string | null;  // set when used is 'native'
  pricePerSearch: number | null;  // USD; null when the provider's price is unknown
  switched: boolean;              // 'auto' moved to Exa so the cap holds
  label: string;                  // "Parallel (fast mode)", "OpenAI's own search"
  note: string;
}

// OpenRouter's catalog entry for openrouter:web_search (GET /tools/...) as a
// view; null when the body isn't the documented shape.
export function parseSearchCatalog(body: unknown): SearchCatalogView | null {
  const tool = (body as { data?: any } | null)?.data;
  if (!tool || !Array.isArray(tool.engines)) return null;
  const prices: EnginePrices = {};
  for (const e of tool.engines) {
    if (!(['exa', 'parallel', 'perplexity'] as BilledEngine[]).includes(e?.id) || e.pricing_source !== 'openrouter' || !Array.isArray(e.pricing)) continue;
    const table: Record<string, number> = {};
    for (const p of e.pricing) {
      const price = Number(p?.price);
      // 'request' rows are the per-search price; 'result' rows only charge
      // past the 10 included results, which Cubex never asks for.
      if (p?.unit === 'request' && Number.isFinite(price) && price >= 0) table[p.mode ?? ''] = price;
    }
    prices[e.id as BilledEngine] = table;
  }
  // An empty list (or one whose entries lost their slug) reads as unknown, not
  // as "no model searches on its own": the fallback list decides then.
  const models = tool.native_support?.models;
  const slugs = Array.isArray(models) ? models.map((m: any) => String(m?.slug ?? '').toLowerCase()).filter(Boolean) : [];
  return { prices, nativeModels: slugs.length > 0 ? new Set<string>(slugs) : null };
}

const baseModel = (model: string) => model.split(':')[0].toLowerCase();

export function hasNativeSearch(model: string, catalog: SearchCatalogView): boolean {
  const id = baseModel(model);
  return catalog.nativeModels ? catalog.nativeModels.has(id) : NATIVE_FALLBACK.some(re => re.test(id));
}

// OpenRouter forwards max_uses to Anthropic's own search and to no other.
export const nativeTakesCap = (model: string) => baseModel(model).startsWith('anthropic/');

export function planWebSearch(
  opts: SearchOptions, model: string, catalog: SearchCatalogView,
): { ok: SearchPlan } | { error: string } {
  const native = hasNativeSearch(model, catalog);
  const provider = nativeSearchProvider(model);
  const takesCap = nativeTakesCap(model);
  const lead: string[] = [];
  let used: SearchEngineUsed;
  let switched = false;

  if (opts.engine === 'auto' || opts.engine === 'native') {
    if (!native) {
      used = 'exa';
      if (opts.engine === 'native') lead.push('This model has no search of its own, so OpenRouter uses Exa.');
    } else if (opts.maxPerRow !== null && !takesCap) {
      if (opts.engine === 'native') {
        return {
          error: `${provider.name}'s own search can't be limited per row, so the limit would be ignored. `
            + 'Remove the limit, or choose Auto (Cubex then uses Exa), Exa, Parallel or Perplexity.',
        };
      }
      used = 'exa'; switched = true;
      lead.push(`${provider.name}'s own search can't be limited per row, so this run uses Exa instead.`);
    } else {
      used = 'native';
    }
  } else {
    used = opts.engine;
  }
  // Perplexity's models search on their own in every request, whatever tool they get.
  if (provider.name === 'Perplexity' && used !== 'native') {
    lead.push('Perplexity models also search on their own in every request; the limit and price below cover only the extra searches.');
  }

  // Send the engine that runs the searches, so OpenRouter can't route them
  // anywhere else (to a model's own search, uncapped, at another price).
  // Only the model's own search is left to OpenRouter's routing.
  const engine: SearchEngine = used === 'native' ? opts.engine : used;
  const chosen = used === opts.engine; // not an Auto or own-search fallback
  const mode = chosen ? opts.mode : null;
  const pricePerSearch = used === 'native' ? provider.price : enginePrice(used, mode, catalog.prices);
  const nativeProvider = used === 'native' ? provider.name : null;
  // A fallback is just "Exa": its default mode wasn't anyone's choice.
  const label = chosen || used === 'native' ? engineLabel(used, mode, nativeProvider) : engineLabel(used, null, null, false);
  const n = opts.maxPerRow;
  return {
    ok: {
      engine, used, mode, maxPerRow: n, nativeProvider, pricePerSearch, switched, label,
      note: [
        ...lead,
        priceSentence(used, label, provider.name, pricePerSearch),
        // Cubex records the search words OpenRouter returns; a model's own search may not return them.
        ...(used === 'native' ? [`Search words show up only when ${provider.name} reports them.`] : []),
        ...(used === 'parallel' && mode === 'turbo' ? ['Turbo mode covers English and Japanese only.'] : []),
        n !== null
          ? `Up to ${n} search${n === 1 ? '' : 'es'} a row${pricePerSearch !== null ? `, so at most ${formatSearchUsd(n * pricePerSearch)} a row in search fees` : ''}.`
          : used !== 'native' ? 'Without a limit, a row usually runs 1 or 2 searches; Cubex stops it once it has 10 results.'
            : takesCap ? 'Without a limit, a row may run several searches.'
              : "It can't be limited per row, so a row may run several searches.",
      ].join(' '),
    },
  };
}

function priceSentence(used: SearchEngineUsed, label: string, provider: string, price: number | null): string {
  if (used !== 'native') {
    return price !== null ? `Searches run on ${label} at ${formatSearchUsd(price)} a search.` : `Searches run on ${label}.`;
  }
  if (price !== null) return `Searches use ${label} at ${provider}'s list price of ${formatSearchUsd(price)} a search.`;
  return provider === 'Perplexity'
    ? `Searches use ${label}, which Perplexity prices into each request, so there's no separate search fee to show.`
    : `Searches use ${label}. ${provider} sets its price per search and Cubex doesn't know it, so try a few rows to measure it.`;
}

// A plan as the API reports it (estimate, preview, run start). engine: what the
// run sends to OpenRouter (exa after a switch); runs_on: what runs the
// searches; mode: the one that bills, the engine's default when none was chosen.
export function webSearchSummary(plan: SearchPlan) {
  return {
    engine: plan.engine,
    runs_on: plan.used,
    mode: hasModes(plan.used) ? (plan.mode ?? DEFAULT_SEARCH_MODE[plan.used]) : null,
    max_searches_per_row: plan.maxPerRow,
    price_per_search_usd: plan.pricePerSearch,
    // true: Auto would have used a model's own search, which ignores the limit,
    // so the run sends Exa instead.
    switched: plan.switched,
    label: plan.label,
    note: plan.note,
  };
}
