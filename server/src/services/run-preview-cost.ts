// What a preview's sample rows cost and what the full run would (run-preview.ts):
// the MEASURED cost, what OpenRouter reports it charged (web fees included)
// when every row says, otherwise real token usage x model pricing; on the
// user's own provider key (BYOK) also what the provider billed the key, since
// OpenRouter then charges only its fee; and what the full run holds on
// OpenRouter's in-flight budget at its concurrency.
import { fetchModels } from '../lib/openrouter';
import { parseTokenPrice, roundUsd } from '../lib/ai-cost';
import { rowPricesOf } from '../lib/ai-spend-limit';
import type { PreviewRowResult } from '../routes/ai-preview-runner';
import { inFlightFor } from './ai-in-flight';

// A preview row's spend beside its cost_usd: provider_cost_usd on the user's own
// provider key (null when OpenRouter didn't say what the provider charged),
// who paid, and its tokens (null where not reported; a call that never came
// back has none to report).
export function spendOf(r: PreviewRowResult) {
  const own = r.paidWith === 'own_key' || r.providerCostUsd !== undefined;
  return {
    ...(own ? { provider_cost_usd: r.providerCostUsd ?? null } : {}),
    paid_with: r.paidWith ?? null,
    tokens: r.tokens ?? { input: null, output: null, reasoning: null },
  };
}

export async function previewCosts(
  userId: string, results: PreviewRowResult[], model: string, count: number,
  o: { maxChars: number | null; concurrency: number; web: boolean },
): Promise<{ fields: Record<string, unknown>; notes: string[] }> {
  const priced = results.filter(r => r.completionTokens !== undefined || r.promptTokens !== undefined
    || r.costUsd !== undefined);
  let measured: number | null = null;
  let perRow: number | null = null;
  let webFeesIncluded = false;
  if (priced.length > 0 && priced.every(r => r.costUsd !== undefined)) {
    const total = priced.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    perRow = total / priced.length;
    measured = roundUsd(total);
    webFeesIncluded = true;
  } else {
    const modelsResult = await fetchModels(Date.now());
    const m = (modelsResult.ok ? modelsResult.models : modelsResult.stale)?.find(x => x.id === model);
    // A negative listed price (one that varies) is no price: the cost stays unknown, never $0.
    if (m && rowPricesOf(m.pricing) && priced.length > 0) {
      const p = parseTokenPrice(m.pricing.prompt);
      const c = parseTokenPrice(m.pricing.completion);
      const total = priced.reduce((sum, r) => sum + (r.promptTokens ?? 0) * p + (r.completionTokens ?? 0) * c, 0);
      perRow = total / priced.length;
      measured = roundUsd(total);
    }
  }
  // Only beside OpenRouter's own figures: the token fallback above already
  // prices the tokens, which is what the provider bills.
  const byok = webFeesIncluded ? priced.filter(r => r.providerCostUsd !== undefined) : [];
  const providerPerRow = byok.length > 0
    ? byok.reduce((sum, r) => sum + (r.providerCostUsd ?? 0), 0) / priced.length : null;
  // From the largest input a sample row really sent. On the user's own provider
  // key too: a row the key can't serve falls back to OpenRouter's credits
  // (lib/ai-in-flight.ts).
  const sent = Math.max(0, ...results.map(r => r.promptTokens ?? 0));
  const ownKey = results.some(r => r.paidWith === 'own_key' || r.providerCostUsd !== undefined);
  const inFlight = sent > 0 ? await inFlightFor(userId, model, sent, o.maxChars, o.concurrency, ownKey) : null;
  const fellBack = ownKey && results.some(r => r.paidWith === 'credits');

  const notes: string[] = [];
  if (providerPerRow !== null) {
    notes.push('These rows ran on your own provider key (BYOK): cost_usd is OpenRouter\'s fee, and provider_cost is '
      + 'what the provider billed your key. projected_total_usd counts both.');
  }
  const unpriced = results.filter(r => r.paidWith === 'own_key' && r.providerCostUsd === undefined).length;
  if (unpriced > 0) {
    notes.push(`OpenRouter didn't say what your provider charged for ${unpriced} row${unpriced === 1 ? '' : 's'} `
      + 'paid with your own key (provider_cost_usd null): the provider bills your key directly, so its own '
      + 'dashboard has that cost.');
  }
  if (fellBack) {
    notes.push('Some rows were paid with OpenRouter credits (paid_with "credits") instead of your own provider key: '
      + 'OpenRouter falls back to its credits when your key can\'t serve a call.');
  }
  if (inFlight?.warning) notes.push(inFlight.warning);
  if (o.web && measured !== null) {
    notes.push(webFeesIncluded
      ? 'Cost is what OpenRouter charged, web search and fetch fees included.'
      : 'Cost is tokens only; web search and fetch fees are not included.');
  }
  return {
    fields: {
      measured_cost_usd: measured,
      per_row_usd: perRow === null ? null : roundUsd(perRow),
      projected_full_run_usd: perRow === null ? null : roundUsd(perRow * count),
      ...(providerPerRow !== null ? {
        provider_cost: {
          measured_usd: roundUsd(providerPerRow * priced.length), per_row_usd: roundUsd(providerPerRow),
          projected_full_run_usd: roundUsd(providerPerRow * count),
        },
        projected_total_usd: roundUsd(((perRow ?? 0) + providerPerRow) * count),
      } : {}),
      ...(inFlight ? { in_flight: inFlight } : {}),
    },
    notes,
  };
}
