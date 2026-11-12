// The money behind the account's keys, in one read (get_balances, GET
// /v1/balances): the treg balance and the enrichment daily limit, what
// OpenRouter reports for the saved key, and the asking access token's spend
// cap with what is left (services/token-spend.ts). Each part answers on its own: one
// service down or not set up never hides the other.
import { readEnrichBalance } from './enrich-setup';
import { dailyLimitOf } from './enrich-agent-shared';
import { readOpenRouterBalanceAt } from './openrouter-balance';
import { OPENROUTER_BALANCE_CACHE_MS } from '../lib/constants';
import { tokenSpendFor } from './token-spend';

const OPENROUTER_NOTE = 'OpenRouter shares the account balance only with a management key, so balance_usd is '
  + 'often null; key_limit_remaining_usd is what this key may still spend (null: no limit set on the key). '
  + 'available_usd is the smaller of the two that are known. Running calls may hold only part of the balance at '
  + 'once (OpenRouter\'s in-flight budget), so a high concurrency can be refused before the balance runs out. '
  + 'Calls on your own provider keys (BYOK) bill that provider; byok_usage_usd is what they used. '
  + `Cubex read these numbers at checked_at and reuses a read for ${OPENROUTER_BALANCE_CACHE_MS / 1000} seconds. `
  + "OpenRouter's key usage and credits can lag behind runs that just finished; access_token.spent_usd is live: "
  + 'Cubex adds what each call cost as soon as its row or preview is done.';

export async function readBalances(userId: string, tokenId: string): Promise<Record<string, unknown>> {
  const [treg, { read: openrouter, at }] = await Promise.all([
    readEnrichBalance(userId), readOpenRouterBalanceAt(userId),
  ]);
  const checkedAt = at === null ? {} : { checked_at: new Date(at).toISOString() };
  return {
    treg: 'ok' in treg
      ? { balance_usd: treg.ok.balanceUsd, on_hold_usd: treg.ok.onHoldUsd }
      : { error: treg.message, ...(treg.fail === 'no_key' ? { connected: false } : {}) },
    enrichment_daily_limit: dailyLimitOf(userId),
    openrouter: 'ok' in openrouter
      ? { ...openrouter.ok, ...checkedAt, note: OPENROUTER_NOTE }
      : { error: openrouter.message, ...(openrouter.fail === 'no_key' ? { connected: false } : {}), ...checkedAt },
    access_token: tokenSpendFor(userId, tokenId),
  };
}
