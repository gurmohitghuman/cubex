// What an AI run's rows came to so far, for its summary (run-status.ts): the
// failed/succeeded counts, what they cost and how many searches ran, in one
// index-only scan of (run_id, status, cost_usd, web_searches) (migration 008).
// Plus the run's search settings as stored.
import { DEFAULT_SEARCH_MODE, hasModes } from '../lib/web-search-options';
import { db } from '../lib/db';

export interface RunSearchSettings {
  engine: string | null; runs_on: string | null; mode: string | null; max_searches_per_row: number | null;
}

// By run id alone: every caller has checked the run is the user's, and a
// user_id filter would turn this index-only scan into a table read.
export function aiRowOutcomes(runId: string) {
  const groups = db.prepare(`
    SELECT status, COUNT(*) AS n, SUM(cost_usd) AS cost, COUNT(cost_usd) AS priced, SUM(web_searches) AS searches
    FROM ai_results WHERE run_id = ? GROUP BY status
  `).all(runId) as Array<{ status: string; n: number; cost: number | null; priced: number; searches: number | null }>;
  const n = (s: string) => groups.find(g => g.status === s)?.n ?? 0;
  const priced = groups.reduce((sum, g) => sum + g.priced, 0);
  const searched = groups.filter(g => g.searches !== null);
  return {
    failed_rows: n('failed'), succeeded_rows: n('completed') + n('accepted'),
    // Rounded past float noise; a run's cost is fractions of a cent per row.
    cost_usd: priced > 0 ? Math.round(groups.reduce((sum, g) => sum + (g.cost ?? 0), 0) * 1e6) / 1e6 : null,
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
