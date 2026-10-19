// What an AI run's rows came to so far, for its summary (run-status.ts): the
// failed/succeeded counts, what they cost (OpenRouter's charge, and on the
// user's own provider key what that provider charged) and how many searches
// ran, in one index-only scan of idx_ai_results_run_spend (migration 022).
// Plus the run's search settings as stored.
import { DEFAULT_SEARCH_MODE, hasModes } from '../lib/web-search-options';
import { db } from '../lib/db';

export interface RunSearchSettings {
  engine: string | null; runs_on: string | null; mode: string | null; max_searches_per_row: number | null;
}

// The results by run id alone: every caller has checked the run is the user's,
// and a user_id filter would turn this index-only scan into a table read. The
// cost also takes in the calls a pause, cancel or resume dropped after they
// came back (ai_dropped_calls, migration 045: billed, so the usage history and
// the token's spend count them too), an index-only sum of their few rows.
type Dropped = { cost: number | null; priced: number; provider: number | null; byok: number };
const droppedOf = (runId: string, userId: string): Dropped => db.prepare(`
  SELECT SUM(cost_usd) AS cost, COUNT(cost_usd) AS priced, SUM(provider_cost_usd) AS provider,
    COUNT(provider_cost_usd) AS byok
  FROM ai_dropped_calls WHERE run_id = ? AND user_id = ?
`).get(runId, userId) as Dropped;

export function aiRowOutcomes(runId: string, userId: string) {
  const groups = db.prepare(`
    SELECT status, COUNT(*) AS n, SUM(cost_usd) AS cost, COUNT(cost_usd) AS priced, SUM(web_searches) AS searches,
      SUM(provider_cost_usd) AS provider, COUNT(provider_cost_usd) AS byok
    FROM ai_results WHERE run_id = ? GROUP BY status
  `).all(runId) as Array<{
    status: string; n: number; cost: number | null; priced: number; searches: number | null;
    provider: number | null; byok: number;
  }>;
  const n = (s: string) => groups.find(g => g.status === s)?.n ?? 0;
  const dropped = droppedOf(runId, userId);
  const priced = groups.reduce((sum, g) => sum + g.priced, dropped.priced);
  const searched = groups.filter(g => g.searches !== null);
  const byok = groups.reduce((sum, g) => sum + g.byok, dropped.byok);
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    failed_rows: n('failed'), succeeded_rows: n('completed') + n('accepted'),
    // Rounded past float noise; a run's cost is fractions of a cent per row.
    cost_usd: priced > 0 ? round(groups.reduce((sum, g) => sum + (g.cost ?? 0), dropped.cost ?? 0)) : null,
    // Only when rows ran on the user's own provider key: what that provider billed it.
    ...(byok > 0
      ? { provider_cost_usd: round(groups.reduce((sum, g) => sum + (g.provider ?? 0), dropped.provider ?? 0)) } : {}),
    searches: searched.length > 0 ? searched.reduce((sum, g) => sum + (g.searches ?? 0), 0) : null,
  };
}

// The engine sent, the engine the searches run on, the mode that bills (the
// engine's default when none was sent) and the cap. engine null: a run from
// before engines could be chosen. undefined without web search.
export function searchSettings(r: {
  use_openrouter_web_search: number | null; web_search_engine?: string | null; web_search_engine_used?: string | null;
  web_search_mode?: string | null; web_search_max_per_row?: number | null;
}): RunSearchSettings | undefined {
  if (!r.use_openrouter_web_search) return undefined;
  const used = r.web_search_engine_used ?? null;
  return {
    engine: r.web_search_engine ?? null, runs_on: used,
    mode: used && hasModes(used) ? (r.web_search_mode ?? DEFAULT_SEARCH_MODE[used]) : null,
    max_searches_per_row: r.web_search_max_per_row ?? null,
  };
}
