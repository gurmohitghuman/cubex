// Per provider, what a run's treg calls did, and the run's cool-down for a
// provider that keeps answering 429. Counted as each answer arrives (a call
// treg ran is billed whether or not its row is written), never for a replay
// (its calls were counted when they ran). The counters live in
// enrich_run_providers (migration 023), so get_run_status reads a few rows.
//
// The cool-down only changes the X-Treg-Route-Exclude header of the run's next
// waterfall calls, never their Idempotency-Key (built from the column's own
// route, lib/enrich-request.ts): a retry or a resume sends the same key and
// treg replays the answer it already has, whichever providers that call left
// out. It is kept per tool (a verified email's finder and checker differ) and
// never leaves out the last provider treg has tried for that tool in this run.
import { db } from '../lib/db';
import { ENRICH_COOLDOWN_AFTER_429S, ENRICH_PROVIDER_COOLDOWN_MS } from '../lib/constants';
import type { ProviderTry } from '../lib/enrich-provider-tries';
import type { RunCtx } from './enrich-step';

// tool id -> provider -> its 429s in a row and when its cool-down ends.
export type Cooldown = Map<string, Map<string, { strikes: number; until: number }>>;

const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// Counts the answer's tries and moves the cool-down. Never throws: the
// counters are a report, and the call they describe is already in the ledger.
export function noteProviderTries(ctx: RunCtx, toolId: string, tries: ProviderTry[], now = Date.now()): void {
  if (tries.length === 0) return;
  const cooled: Array<[string, number]> = [];
  const tool = ctx.cooldown.get(toolId) ?? new Map();
  ctx.cooldown.set(toolId, tool);
  for (const t of tries) {
    const s = tool.get(t.provider) ?? { strikes: 0, until: 0 };
    if (t.status === 429) {
      if (++s.strikes >= ENRICH_COOLDOWN_AFTER_429S) {
        s.strikes = 0;
        s.until = now + ENRICH_PROVIDER_COOLDOWN_MS;
        cooled.push([t.provider, s.until]);
      }
    } else if (t.outcome === 'hit' || t.outcome === 'miss') {
      s.strikes = 0;
    }
    tool.set(t.provider, s);
  }
  try {
    const add = db.prepare(`
      INSERT INTO enrich_run_providers (run_id, user_id, provider, tried, hits, misses, errors, rate_limited, skipped,
        cost_micro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider) DO UPDATE SET tried = tried + excluded.tried, hits = hits + excluded.hits,
        misses = misses + excluded.misses, errors = errors + excluded.errors,
        rate_limited = rate_limited + excluded.rate_limited, skipped = skipped + excluded.skipped,
        cost_micro = cost_micro + excluded.cost_micro
    `);
    const cool = db.prepare('UPDATE enrich_run_providers SET cooling_until = ? WHERE run_id = ? AND provider = ?');
    db.transaction(() => {
      for (const t of tries) {
        add.run(ctx.runId, ctx.userId, t.provider, t.outcome === 'skipped' ? 0 : 1,
          t.outcome === 'hit' ? 1 : 0, t.outcome === 'miss' ? 1 : 0,
          t.outcome === 'error' ? 1 : 0, t.status === 429 ? 1 : 0, t.outcome === 'skipped' ? 1 : 0, t.chargedMicro);
      }
      for (const [provider, until] of cooled) cool.run(iso(until), ctx.runId, provider);
    })();
  } catch (error) {
    console.error(`Enrichment run ${ctx.runId}: counting providers failed:`, (error as Error).message);
  }
}

// A new worker starts with no cool-down (it lives in the worker's memory), so
// the status mustn't show the last one's.
export function clearCooldowns(runId: string, userId: string): void {
  db.prepare('UPDATE enrich_run_providers SET cooling_until = NULL WHERE run_id = ? AND user_id = ?')
    .run(runId, userId);
}

// The providers a waterfall call of this tool leaves out: the column's own,
// plus those cooling down, unless that would leave none of the providers treg
// has tried for the tool in this run.
export function excludeWithCooldown(
  ctx: RunCtx, toolId: string, exclude: string[] | undefined, now = Date.now(),
): string[] | undefined {
  const tool = ctx.cooldown.get(toolId);
  if (!tool) return exclude;
  const own = new Set((exclude ?? []).map(p => p.toLowerCase()));
  const known = [...tool.keys()].filter(p => !own.has(p));
  const cooling = known.filter(p => (tool.get(p)?.until ?? 0) > now);
  if (cooling.length === 0 || cooling.length === known.length) return exclude;
  return [...(exclude ?? []), ...cooling].sort();
}

export interface ProviderCount {
  provider: string; tried: number; hits: number; misses: number; errors: number; rate_limited: number;
  skipped: number; cost_usd: number; cooling_down_until?: string;
}

// A run's providers, most asked first (a waterfall asks at most a few dozen).
export function runProviders(runId: string, userId: string, names: Record<string, string>): ProviderCount[] {
  const rows = db.prepare(`
    SELECT provider, tried, hits, misses, errors, rate_limited, skipped, cost_micro,
      CASE WHEN cooling_until > datetime('now') THEN cooling_until END AS cooling
    FROM enrich_run_providers WHERE run_id = ? AND user_id = ? ORDER BY tried DESC, provider LIMIT 100
  `).all(runId, userId) as Array<{
    provider: string; tried: number; hits: number; misses: number; errors: number; rate_limited: number;
    skipped: number; cost_micro: number; cooling: string | null;
  }>;
  return rows.map(r => ({
    provider: names[r.provider] ?? r.provider, tried: r.tried, hits: r.hits, misses: r.misses, errors: r.errors,
    rate_limited: r.rate_limited, skipped: r.skipped, cost_usd: r.cost_micro / 1e6,
    ...(r.cooling ? { cooling_down_until: `${r.cooling.replace(' ', 'T')}Z` } : {}),
  }));
}
