// The list part of an enrichment run, checked against the tool as treg's
// catalog describes it: where the results are in the answer, the one provider
// a list job asks (treg returns each provider's own rows, so mixing providers
// would mix shapes), the page size sent as `limit`, and what a row can cost.
import { ENRICH_LIST_MAX_ITEMS } from '../lib/constants';
import { providerCanAnswer } from '../lib/enrich-accepts';
import { routeFor, type EnrichRoute } from '../lib/enrich-run-config';
import type { ListInput } from '../lib/enrich-list-input';
import type { EnrichTool, ToolProvider } from '../lib/enrich-tool';
import { getTool } from './enrich-catalog';
import type { RunFail } from './run-shared';

export interface ListPlan {
  route: EnrichRoute;
  itemsPath: string;
  provider: string | null;
  // The waterfall's page-size input ("THE price dial"), sent as maxItems.
  limitInput: string | null;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// The waterfall providers a list run may pick: usable in a sheet and able to
// answer the inputs mapped.
export function listProviders(tool: EnrichTool, given: string[]): ToolProvider[] {
  const sent = new Set(given);
  const known = new Set(tool.inputs.map(i => i.name));
  return (tool.providers ?? []).filter(p => !p.exhausted && !p.unavailable
    && providerCanAnswer(p.accepts, sent, tool.derive, known));
}

// Where the results are: the catalog's list, or (a single tool) another list
// of its example answer that the run names (refused once the example lacks it).
function itemsPathOf(tool: EnrichTool, list: ListInput): string | null {
  const asked = list.itemsPath ?? null;
  if (!asked || asked === tool.list?.path) return tool.list?.path ?? null;
  return tool.kind === 'single' && tool.arrays.includes(asked) ? asked : null;
}

export function planListRun(tool: EnrichTool, list: ListInput, given: string[]): ListPlan | RunFail {
  const itemsPath = itemsPathOf(tool, list);
  if (!itemsPath) {
    return bad(list.itemsPath && tool.kind === 'single'
      ? `This tool's answer has no list at ${list.itemsPath}.`
      : "This tool doesn't return a list of results, so it can't add rows.");
  }
  // A tool that takes treg's `limit` is asked for the results per row (and
  // priced at it), within the range treg declares for that input.
  const lim = tool.inputs.find(i => i.name === 'limit');
  const lo = Math.max(1, Math.ceil(lim?.min ?? 1));
  const hi = Math.min(ENRICH_LIST_MAX_ITEMS, Math.floor(lim?.max ?? ENRICH_LIST_MAX_ITEMS));
  if (list.maxItems < lo || list.maxItems > hi) return bad(`Results per row must be ${lo} to ${hi}.`);
  const limitInput = lim ? 'limit' : null;
  if (tool.kind !== 'waterfall') {
    return { route: routeFor(tool, [], [], false), itemsPath, provider: null, limitInput };
  }
  if (!list.provider) return bad('Pick the provider whose results become rows.');
  const slug = list.provider.toLowerCase();
  const usable = listProviders(tool, given);
  if (!usable.some(p => p.provider.toLowerCase() === slug)) {
    const known = (tool.providers ?? []).find(p => p.provider.toLowerCase() === slug);
    return bad(known
      ? `${known.name ?? known.provider} can't search with these inputs. Map other inputs or pick another provider.`
      : `${list.provider} isn't one of this tool's providers anymore. Pick another provider.`);
  }
  const others = (tool.providers ?? []).map(p => p.provider).filter(p => p.toLowerCase() !== slug);
  return {
    // One provider: preferred, every other one excluded (own keys and free
    // routes would otherwise run first), and no next provider on a miss.
    route: routeFor(tool, [slug], others, true),
    itemsPath, provider: slug, limitInput,
  };
}

// What one list call can cost: for each of the provider's endpoints that can
// answer, its own catalog price (per result times the page size), the
// cheapest and the dearest. An endpoint whose details can't be read counts
// its plan price per result (the safe side for a ceiling).
export async function listRowPrices(
  tool: EnrichTool, provider: string, given: string[], maxItems: number,
): Promise<{ lowUsd: number; highUsd: number }> {
  const eps = listProviders(tool, given).filter(p => p.provider.toLowerCase() === provider.toLowerCase());
  const prices = await Promise.all(eps.map(async p => {
    const found = await getTool(p.endpointId);
    if (!('ok' in found)) return (p.usd ?? 0) * maxItems;
    const t = found.ok;
    const unit = Math.max(t.price.usd ?? p.usd ?? 0, t.price.overflowUsd ?? 0);
    return t.price.type === 'per_result' ? unit * maxItems : unit;
  }));
  if (prices.length === 0) return { lowUsd: 0, highUsd: 0 };
  return { lowUsd: round6(Math.min(...prices)), highUsd: round6(Math.max(...prices)) };
}
