// The column menu's enrichment actions (Run rows not enriched, Retry failed
// rows, Run selected rows, Run all rows again): the column's own setup from its
// newest run, on other rows, through the same start as the drawer (the plain
// HTTP rerun refuses enrichment columns). estimateOnly is a pure read for the
// confirm: how many rows, what they could cost and where the run stops.
import { recallChoices, rerunInput } from '../lib/enrich-run-recall';
import type { RerunInput } from '../lib/enrich-run-input';
import { countFor, enrichRowCounts } from './enrich-row-count';
import { estimateEnrichment } from './enrich-setup';
import { loadColumnRun } from './enrich-column';
import { startEnrichmentRun, type EnrichStartOutcome } from './enrich-run-start';
import type { DailyLimitView } from './treg-key';
import type { RunFail } from './run-shared';

export interface RerunEstimate {
  column: string; toolName: string; rows: number;
  // false: the provider bills the team's own key directly, so there are no figures.
  priceKnown: boolean;
  lowUsd: number; highUsd: number;
  maxCostPerRowUsd: number | null; spendLimitUsd: number | null;
  dailyLimit: DailyLimitView;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function rerunEnrichmentColumn(
  userId: string, sheetId: string, req: RerunInput,
): Promise<{ ok: { estimate: RerunEstimate } } | EnrichStartOutcome> {
  const run = loadColumnRun(sheetId, userId, req.column);
  if ('fail' in run) return run;
  const choices = recallChoices(run.config, req.column);
  if (!req.estimateOnly) {
    return startEnrichmentRun(userId, sheetId, rerunInput(choices, req.rows, req.spendLimitUsd, req.rowGeneration));
  }

  const { mode, rowIndexes } = req.rows;
  const counts = await enrichRowCounts(sheetId, userId, req.column, { mode, rowIndexes });
  const rows = countFor(counts, req.rows.status);
  const est = await estimateEnrichment(userId, {
    toolId: choices.toolId, rows, preset: choices.preset, given: Object.keys(choices.inputs).sort(),
    skip: choices.skipProviders, order: choices.providerOrder, stopAtFirst: choices.stopAtFirst,
    maxCostPerRowUsd: choices.maxCostPerRowUsd, limit: null,
  });
  if (!('ok' in est)) {
    const upstream = est.fail === 'unreachable' || est.fail === 'upstream';
    return { fail: upstream ? 'upstream' : 'bad_request', message: est.message } satisfies RunFail;
  }
  const { priceKnown, estimate, dailyLimit } = est.ok;
  const cap = priceKnown ? choices.maxCostPerRowUsd ?? est.ok.defaultMaxCostPerRowUsd : null;
  return {
    ok: {
      estimate: {
        column: req.column, toolName: run.config.enrichment.toolName, rows, priceKnown,
        lowUsd: estimate.lowUsd, highUsd: estimate.highUsd, maxCostPerRowUsd: cap,
        spendLimitUsd: cap === null ? null : round6(Math.max(rows, 1) * cap), dailyLimit,
      },
    },
  };
}
