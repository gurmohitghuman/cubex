// What OpenRouter tells Cubex about the money behind the saved key, for
// get_balances and the in-flight check (services/ai-in-flight.ts). The account
// balance comes from /credits, which OpenRouter documents as needing a
// management key, so with an ordinary key it is usually refused; the key's own
// spending limit (/key: limit_remaining, null when none is set) is then all
// that says how much can still be spent. Nothing is guessed: what OpenRouter
// doesn't return stays null. Read at most every OPENROUTER_BALANCE_CACHE_MS.
import { OPENROUTER_BALANCE_CACHE_MS, OPENROUTER_BALANCE_TIMEOUT_MS } from '../lib/constants';
import { fetchAccountBalance, validateKey } from '../lib/openrouter';
import { getOpenRouterApiKey } from './openrouter';

export interface OpenRouterBalance {
  balance_usd: number | null;             // account credits left, when OpenRouter shares them
  key_limit_usd: number | null;           // the key's own spending limit (null: none)
  key_limit_remaining_usd: number | null;
  key_usage_usd: number | null;
  byok_usage_usd: number | null;          // spent on your own provider keys through OpenRouter
  is_free_tier: boolean | null;
  available_usd: number | null;           // the smaller of the two above that are known
}

export type OpenRouterBalanceRead =
  | { ok: OpenRouterBalance }
  | { fail: 'no_key' | 'rejected' | 'unavailable'; message: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cache = new Map<string, { at: number; key: string; read: OpenRouterBalanceRead }>();

async function readFresh(key: string): Promise<OpenRouterBalanceRead> {
  try {
    const [check, balance] = await Promise.all([
      validateKey(key, OPENROUTER_BALANCE_TIMEOUT_MS), fetchAccountBalance(key, OPENROUTER_BALANCE_TIMEOUT_MS),
    ]);
    if (!check.ok) {
      return check.status === 401
        ? { fail: 'rejected', message: 'OpenRouter rejected the saved key. Check it in Settings.' }
        : { fail: 'unavailable', message: `OpenRouter answered ${check.status}.` };
    }
    const d = check.data ?? {};
    const remaining = num(d.limit_remaining);
    const known = [balance, remaining].filter((v): v is number => v !== null);
    return {
      ok: {
        balance_usd: balance, key_limit_usd: num(d.limit), key_limit_remaining_usd: remaining,
        key_usage_usd: num(d.usage), byok_usage_usd: num(d.byok_usage),
        is_free_tier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
        available_usd: known.length ? Math.min(...known) : null,
      },
    };
  } catch {
    return { fail: 'unavailable', message: "Couldn't reach OpenRouter." };
  }
}

export async function readOpenRouterBalance(userId: string): Promise<OpenRouterBalanceRead> {
  const key = getOpenRouterApiKey(userId);
  if (!key) return { fail: 'no_key', message: 'No OpenRouter key saved. Add one in Settings.' };
  const hit = cache.get(userId);
  if (hit && hit.key === key && Date.now() - hit.at < OPENROUTER_BALANCE_CACHE_MS) return hit.read;
  const read = await readFresh(key);
  cache.set(userId, { at: Date.now(), key, read });
  return read;
}
