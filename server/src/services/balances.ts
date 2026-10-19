// The money behind the account's keys, in one read (get_balances, GET
// /v1/balances): the treg balance and the enrichment daily limit, what
// OpenRouter reports for the saved key, and the asking access token's spend
// cap with what is left (services/token-spend.ts). Each part answers on its own: one
// service down or not set up never hides the other.
import { readEnrichBalance } from './enrich-setup';
import { dailyLimitOf } from './enrich-agent-shared';
import { readOpenRouterBalance } from './openrouter-balance';
import { tokenSpendFor } from './token-spend';

const OPENROUTER_NOTE = 'OpenRouter shares the account balance only with a management key, so balance_usd is '
  + 'often null; key_limit_remaining_usd is what this key may still spend (null: no limit set on the key). '
  + 'available_usd is the smaller of the two that are known. Running calls may hold only part of the balance at '
  + 'once (OpenRouter\'s in-flight budget), so a high concurrency can be refused before the balance runs out. '
  + 'Calls on your own provider keys (BYOK) bill that provider; byok_usage_usd is what they used.';

export async function readBalances(userId: string, tokenId: string): Promise<Record<string, unknown>> {
  const [treg, openrouter] = await Promise.all([readEnrichBalance(userId), readOpenRouterBalance(userId)]);
  return {
    treg: 'ok' in treg
      ? { balance_usd: treg.ok.balanceUsd, on_hold_usd: treg.ok.onHoldUsd }
      : { error: treg.message, ...(treg.fail === 'no_key' ? { connected: false } : {}) },
    enrichment_daily_limit: dailyLimitOf(userId),
    openrouter: 'ok' in openrouter
      ? { ...openrouter.ok, note: OPENROUTER_NOTE }
      : { error: openrouter.message, ...(openrouter.fail === 'no_key' ? { connected: false } : {}) },
    access_token: tokenSpendFor(userId, tokenId),
  };
}
