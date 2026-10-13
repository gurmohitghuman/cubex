// The in-flight check for an AI run's estimate and preview: the model's prices
// and the account balance OpenRouter reports, put through
// lib/ai-in-flight.ts. null when the model or its prices are unknown, or the
// model is free (nothing is held).
import { aiMaxTokens } from '../lib/constants';
import { fetchModels } from '../lib/openrouter';
import { parseTokenPrice } from '../lib/ai-cost';
import { inFlightCheck, type InFlight } from '../lib/ai-in-flight';
import { readOpenRouterBalance } from './openrouter-balance';

export async function inFlightFor(
  userId: string, model: string | null, inputTokens: number, maxChars: number | null, concurrency: number,
): Promise<InFlight | null> {
  if (!model) return null;
  const result = await fetchModels(Date.now());
  const m = (result.ok ? result.models : result.stale)?.find(x => x.id === model);
  if (!m) return null;
  const balance = await readOpenRouterBalance(userId);
  return inFlightCheck({
    concurrency, inputTokens, maxTokens: aiMaxTokens(maxChars),
    promptPrice: parseTokenPrice(m.pricing.prompt), completionPrice: parseTokenPrice(m.pricing.completion),
    balanceUsd: 'ok' in balance ? balance.ok.balance_usd : null,
  });
}
