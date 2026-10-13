// What a preview's sample rows cost and what the full run would (run-preview.ts):
// the MEASURED cost, what OpenRouter reports it charged (web fees included)
// when every row says, otherwise real token usage x model pricing; on the
// user's own provider key (BYOK) also what the provider billed the key, since
// OpenRouter then charges only its fee; and what the full run holds on
// OpenRouter's in-flight budget at its concurrency.
import { fetchModels } from '../lib/openrouter';
import { parseTokenPrice, roundUsd } from '../lib/ai-cost';
import type { PreviewRowResult } from '../routes/ai-preview-runner';
import { inFlightFor } from './ai-in-flight';

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
    if (m && priced.length > 0) {
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
  // From the largest input a sample row really sent; nothing is held in flight
  // for calls on the user's own provider key, unless a paid plugin runs too.
  const sent = Math.max(0, ...results.map(r => r.promptTokens ?? 0));
  const inFlight = sent > 0 && (byok.length === 0 || o.web)
    ? await inFlightFor(userId, model, sent, o.maxChars, o.concurrency) : null;

  const notes: string[] = [];
  if (providerPerRow !== null) {
    notes.push('These rows ran on your own provider key (BYOK): cost_usd is OpenRouter\'s fee, and provider_cost is '
      + 'what the provider billed your key. projected_total_usd counts both.');
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
