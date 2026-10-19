// A token's spend cap (migration 042, lib/token-spend.ts): what the runs done
// for an access token spent, read from token_spend (the sum of its usage
// records, kept by triggers and never lowered), against the cap set in
// Settings. Read in the API process (a start, a resume, a preview, the
// surfaces) and by the run workers before each call or batch of rows (their
// own connection, lib/db), so a check sees what every other worker wrote.
//
// "At the cap" means no room for one more of the run's rows: for an AI run (or
// a run with no per-row cap) what was spent reached the cap; for an
// enrichment or waterfall run with a per-row cap, less than one row's cap is
// left. A plain HTTP API run costs nothing here and is never held back.
import { db } from '../lib/db';
import { actorTokenId } from '../lib/actor';
import { limitReached, rowsThatFit } from '../lib/enrich-estimate';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { isWaterfallConfig } from '../lib/waterfall/config';
import {
  capNoRoomMessage, capReached, capReachedMessage, LIFETIME_NOTE, spendView, type CapOf, type SpendView,
} from '../lib/token-spend';
import { tokenHeldMicro } from './enrich-holds';

export interface TokenSpend extends CapOf { capUsd: number; view: SpendView }
type Read = Omit<TokenSpend, 'capUsd'> & { capUsd: number | null };

// Spent: the usage history's figures (OpenRouter, the user's own provider key, treg).
type Row = { id: string; name: string; cap: number | null; spent: number; revoked: number };

const readOf = (r: Row): Read => ({
  name: r.name, revoked: r.revoked === 1, capUsd: r.cap === null ? null : r.cap / 1e6, spentUsd: r.spent,
  view: spendView(r.cap, r.spent),
});

export function readTokenSpend(userId: string, tokenId: string): Read | null {
  const r = db.prepare(`SELECT t.id, t.name, t.spend_cap_micro AS cap, t.revoked_at IS NOT NULL AS revoked,
      IFNULL(s.ai_cost_usd, 0) + IFNULL(s.provider_cost_usd, 0) + IFNULL(s.enrich_micro, 0) / 1e6 AS spent
    FROM access_tokens t LEFT JOIN token_spend s ON s.access_token_id = t.id AND s.user_id = t.user_id
    WHERE t.id = ? AND t.user_id = ?`).get(tokenId, userId) as Row | undefined;
  return r ? readOf(r) : null;
}

const capped = (userId: string, tokenId: string | null | undefined): TokenSpend | null => {
  const t = tokenId ? readTokenSpend(userId, tokenId) : null;
  return t && t.capUsd !== null ? t as TokenSpend : null;
};

// What one more row of a run can cost: a dollar cap, null (no bound: an AI
// run, or an enrichment billed on the team's own provider key) or 'free' (a
// plain HTTP API run). `config` is an HTTP run's stored config.
export type RowCost = number | null | 'free';
export function rowCostOf(kind: 'ai' | 'http', config: string | null | undefined): RowCost {
  if (kind === 'ai') return null;
  let c: unknown = null;
  try { c = JSON.parse(config ?? 'null'); } catch { /* below */ }
  if (isEnrichmentConfig(c)) return c.enrichment.maxCostPerRowUsd;
  if (isWaterfallConfig(c)) return c.waterfall.maxCostPerRowUsd > 0 ? c.waterfall.maxCostPerRowUsd : null;
  return 'free';
}

// Why something that spends for `tokenId` may not start (or go on) now; null:
// it may, or it isn't a token's, or it costs nothing.
export function spendCapRefusal(userId: string, tokenId: string | null | undefined, cost: RowCost = null)
  : string | null {
  if (cost === 'free') return null;
  const t = capped(userId, tokenId);
  if (!t || !limitReached(t.capUsd, t.spentUsd, cost)) return null;
  return cost !== null && !capReached(t.capUsd, t.spentUsd) ? capNoRoomMessage(t, cost) : capReachedMessage(t);
}

// Whom a paused run (or setup) spends for once resumed (services/run-lifecycle.ts):
// an access token resuming it makes it its own; the app resuming keeps its
// token, unless that token was revoked (its cap can never be raised again):
// then the app takes it over and it spends for no token (null).
export function resumeTokenFor(userId: string, runToken: string | null | undefined): string | null {
  const actor = actorTokenId();
  if (actor) return actor;
  if (!runToken) return null;
  return readTokenSpend(userId, runToken)?.revoked ? null : runToken;
}

// The same for the token of the request being served (lib/actor.ts).
export const actorSpendRefusal = (userId: string, cost: RowCost = null): string | null =>
  spendCapRefusal(userId, actorTokenId(), cost);

// The enrichment and waterfall row holds' room under the run's token cap, read
// inside their IMMEDIATE transaction: how many more rows fit at up to
// `perRowUsd` each after what the token's runs spent and hold (this run's
// rows still out included). No per-row cap (null): only what was billed stops
// it; a row that costs nothing (0) always fits.
export function tokenRowsThatFit(userId: string, tokenId: string | null | undefined, perRowUsd: number | null)
  : { rows: number } | { reason: 'token_cap'; message: string } {
  const t = capped(userId, tokenId);
  if (!t) return { rows: Infinity };
  const refused = spendCapRefusal(userId, tokenId, perRowUsd);
  if (refused) return { reason: 'token_cap', message: refused };
  if (perRowUsd === null) return { rows: Infinity };
  return { rows: rowsThatFit(t.capUsd, t.spentUsd + tokenHeldMicro(userId, tokenId!) / 1e6, perRowUsd) };
}

// Settings → Agent access: each live token's cap and spend, by token id.
export function tokenSpendViews(userId: string): Map<string, SpendView> {
  const rows = db.prepare(`SELECT t.id, t.name, t.spend_cap_micro AS cap, 0 AS revoked,
      IFNULL(s.ai_cost_usd, 0) + IFNULL(s.provider_cost_usd, 0) + IFNULL(s.enrich_micro, 0) / 1e6 AS spent
    FROM access_tokens t LEFT JOIN token_spend s ON s.access_token_id = t.id AND s.user_id = t.user_id
    WHERE t.user_id = ? AND t.revoked_at IS NULL`).all(userId) as Row[];
  return new Map(rows.map(r => [r.id, readOf(r).view]));
}

// Sets (or, with null, removes) a live token's cap; null when there is no such token.
// Only the app calls it: a token never changes a cap, its own or another's.
export function setTokenSpendCap(userId: string, tokenId: string, capMicro: number | null): SpendView | null {
  const r = db.prepare(`UPDATE access_tokens SET spend_cap_micro = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).run(capMicro, tokenId, userId);
  return r.changes === 1 ? readTokenSpend(userId, tokenId)?.view ?? null : null;
}

// What an agent is told about its own token (GET /v1/me, get_balances): the
// cap (null: none), spent and left, and that it is for life.
export function tokenSpendFor(userId: string, tokenId: string): (SpendView & { note: string }) | null {
  const t = readTokenSpend(userId, tokenId);
  if (!t) return null;
  return { ...t.view, note: t.capUsd === null ? 'This access token has no spend cap.' : LIFETIME_NOTE };
}

// A paid run's start answer carries the token's spend, when it has a cap.
export function spendPart(userId: string, tokenId: string): { token_spend?: SpendView } {
  const t = capped(userId, tokenId);
  return t ? { token_spend: t.view } : {};
}
