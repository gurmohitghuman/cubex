// The waterfall parts of the programmatic run reads (services/run-status.ts:
// get_run_status, list_runs, get_run_results and their /api/v1 routes): a
// summary's spend, limit and per-step counts, and a result row's answering
// step, cost and trace. Bounded: the run's few tally rows, a page of results.
import { db } from '../lib/db';
import { waterfallConfigOf } from '../lib/waterfall/config';
import { waterfallStatusOf } from './waterfall-status';
import { storedTrace } from './waterfall-trace';

// The summary part (none for a run that isn't a waterfall).
export function waterfallSummaryPart(
  r: any, userId: string,
): { waterfall?: Record<string, unknown>; cost_usd?: number } {
  const s = r.ai_cost_usd === undefined ? null : waterfallStatusOf(r, userId);
  if (!s) return {};
  return {
    cost_usd: s.spent.total_usd,
    waterfall: {
      result_type: s.result_type, dry: s.dry, answered_by_column: s.answered_by_column, spent: s.spent,
      run_limit_usd: s.run_limit_usd, pause_reason: s.pause_reason, steps: s.steps,
    },
  };
}

// Per result row: the answering step's label, the row's cost and its trace.
export function waterfallResultExtras(
  rawConfig: string | null, runId: string, userId: string, rowIndexes: number[],
): Map<number, { answered_by: string | null; cost_usd: number | null; trace: unknown }> | null {
  const config = waterfallConfigOf(rawConfig);
  if (!config || rowIndexes.length === 0) return null;
  const labels = new Map(config.waterfall.steps.map(s => [s.id, s.label]));
  const rows = db.prepare(`SELECT row_index, response_data, cost_usd FROM http_results
    WHERE run_id = ? AND user_id = ? AND row_index IN (SELECT value FROM json_each(?))`)
    .all(runId, userId, JSON.stringify(rowIndexes)) as Array<{ row_index: number; response_data: string | null;
      cost_usd: number | null }>;
  const out = new Map<number, { answered_by: string | null; cost_usd: number | null; trace: unknown }>();
  for (const r of rows) {
    const trace = storedTrace(r.response_data);
    out.set(r.row_index, {
      answered_by: trace?.answered_by ? labels.get(trace.answered_by) ?? null : null, cost_usd: r.cost_usd,
      trace: trace?.steps ?? null,
    });
  }
  return out;
}
