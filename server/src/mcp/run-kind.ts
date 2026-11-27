// A run's kind as an agent names it, for get_run and control_run (its undo included). An enrichment or a waterfall
// is an HTTP run: run_type 'enrichment' or 'waterfall' reads and controls the same run, and refuses another kind so
// the caller isn't misled.
import { isEnrichmentRun } from '../services/enrich-agent-control';
import { isWaterfallRun } from '../services/waterfall-agent-control';

export type RunTypeArg = 'ai' | 'http' | 'enrichment' | 'waterfall';

export function kindOf(runType: RunTypeArg, runId: string, userId: string): 'ai' | 'http' | null {
  if (runType === 'enrichment') return isEnrichmentRun(runId, userId) ? 'http' : null;
  if (runType === 'waterfall') return isWaterfallRun(runId, userId) ? 'http' : null;
  return runType;
}
