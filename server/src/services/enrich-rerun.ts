// The column menu's enrichment actions (Run rows not enriched, Retry failed
// rows, Run selected rows, Run all rows again): the column's own setup from its
// newest run, on other rows, through the same start as the drawer (the plain
// HTTP rerun refuses enrichment columns). estimateOnly is a pure read for the
// confirm: how many rows, how many reuse an earlier found answer at $0, what
// the others could cost and where the run stops.
import { db } from '../lib/db';
import { estimateListOf, recallChoices, rerunInput } from '../lib/enrich-run-recall';
import type { RerunInput } from '../lib/enrich-run-input';
import { countFor, enrichRowCounts } from './enrich-row-count';
import { estimateEnrichment } from './enrich-setup';
import { loadColumnRun } from './enrich-column';
import { startEnrichmentRun, type EnrichStartOutcome } from './enrich-run-start';
import type { DailyLimitView } from './treg-key';
import { storedRule } from './run-rule';
import type { RunFail } from './run-shared';
import { countReusable, reuseJobFor, type ReuseCount } from './enrich-reuse-count';
import { prepareEnrichmentStart } from './enrich-run-prepare';
import { statusStaleCheck } from './run-inputs';

export interface RerunEstimate {
  column: string; toolName: string; rows: number;
  // Rows that reuse a found answer at $0 (reuseComplete false: at least that many).
  reusedRows: number; reuseComplete: boolean;
  // false: the provider bills the team's own key directly, so there are no figures.
  priceKnown: boolean;
  lowUsd: number; highUsd: number;
  maxCostPerRowUsd: number | null; spendLimitUsd: number | null;
  dailyLimit: DailyLimitView;
  // A list job: the sheet its rows go to, and how many it may add.
  addsRowsTo: { name: string; addUpTo: number } | null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// Rows of the rerun that reuse a found answer, counted on the run it would
// start (its config built as the start builds it, from treg's catalog now, so
// the lookups match), not on the column's newest run. null: none counted (it
// calls every row, or the start would refuse, say a run is still going).
async function rerunReuse(
  userId: string, sheetId: string, choices: ReturnType<typeof recallChoices>, req: RerunInput, rows: number,
): Promise<ReuseCount | null> {
  if (req.callAgain || rows === 0) return null;
  const input = rerunInput(choices, req.rows, null, req.rowGeneration, null);
  const prepared = await prepareEnrichmentStart(userId, sheetId, input);
  if ('fail' in prepared) return null;
  return countReusable(userId, reuseJobFor(userId, sheetId, input, prepared.ok));
}

export async function rerunEnrichmentColumn(
  userId: string, sheetId: string, req: RerunInput,
): Promise<{ ok: { estimate: RerunEstimate } } | EnrichStartOutcome> {
  const run = loadColumnRun(sheetId, userId, req.column);
  if ('fail' in run) return run;
  const choices = recallChoices(run.config, req.column);
  if (!req.estimateOnly) {
    const input = rerunInput(choices, req.rows, req.spendLimitUsd, req.rowGeneration, req.concurrency ?? null);
    return startEnrichmentRun(userId, sheetId, req.callAgain ? { ...input, noReuse: true } : input);
  }

  const { mode, rowIndexes } = req.rows;
  const rule = storedRule(sheetId, userId, choices.runIf);
  if ('error' in rule) return { fail: 'bad_request', message: rule.error } satisfies RunFail;
  const scope = {
    mode, rowIndexes, where: choices.conditions, rule: rule.ok?.tree ?? null,
    stale: statusStaleCheck(sheetId, userId, req.column, req.rows.status),
  };
  const counts = await enrichRowCounts(sheetId, userId, req.column, scope);
  const rows = countFor(counts, req.rows.status);
  const reuse = await rerunReuse(userId, sheetId, choices, req, rows);
  const reused = reuse?.rows ?? 0;
  const paid = Math.max(0, rows - reused);
  const est = await estimateEnrichment(userId, {
    toolId: choices.toolId, rows: paid, preset: choices.preset, given: Object.keys(choices.inputs).sort(),
    skip: choices.skipProviders, order: choices.providerOrder, stopAtFirst: choices.stopAtFirst,
    maxCostPerRowUsd: choices.maxCostPerRowUsd, limit: null, list: estimateListOf(choices),
  });
  if (!('ok' in est)) {
    const upstream = est.fail === 'unreachable' || est.fail === 'upstream';
    return { fail: upstream ? 'upstream' : 'bad_request', message: est.message } satisfies RunFail;
  }
  const { priceKnown, estimate, dailyLimit } = est.ok;
  const destId = choices.list && 'sheetId' in choices.list.dest ? choices.list.dest.sheetId : null;
  const dest = destId ? db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(destId, userId) as string | undefined : undefined;
  const addsRowsTo = est.ok.list ? { name: dest ?? 'a deleted sheet', addUpTo: est.ok.list.addUpTo } : null;
  const cap = priceKnown ? choices.maxCostPerRowUsd ?? est.ok.defaultMaxCostPerRowUsd : null;
  return {
    ok: {
      estimate: {
        column: req.column, toolName: run.config.enrichment.toolName, rows, priceKnown,
        reusedRows: reused, reuseComplete: reuse?.complete ?? true,
        lowUsd: estimate.lowUsd, highUsd: estimate.highUsd, maxCostPerRowUsd: cap,
        // One row more than the paid ones when some reuse: a found answer can go stale before the run.
        spendLimitUsd: cap === null ? null : round6(Math.max(paid + (reused > 0 ? 1 : 0), 1) * cap),
        dailyLimit, addsRowsTo,
      },
    },
  };
}
