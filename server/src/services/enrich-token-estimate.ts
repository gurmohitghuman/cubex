// run_enrichment's estimate_only (MCP and /api/v1): the start's own checks
// (services/enrich-run-prepare.ts) and the drawer's estimate figures for the
// rows the run would take, rows that reuse an earlier found answer at $0 left
// out of the price. A pure read: nothing is created, no treg tool is called
// (the catalog and the balance are reads).
import type { EnrichRunInput } from '../lib/enrich-run-input';
import { prepareEnrichmentStart } from './enrich-run-prepare';
import { estimateEnrichment, readEnrichBalance } from './enrich-setup';
import { getTregToken } from './treg-key';
import { dailyLimitOf } from './enrich-agent-shared';
import { countReusable, reuseJobFor } from './enrich-reuse-count';
import type { RunFail } from './run-shared';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function agentEnrichEstimate(
  userId: string, sheetId: string, input: EnrichRunInput,
): Promise<{ ok: Record<string, unknown> } | RunFail> {
  const prepared = await prepareEnrichmentStart(userId, sheetId, input);
  if ('fail' in prepared) return prepared;
  const { config, upperBound, statusColumn, outputNames, listPlan } = prepared.ok;
  const e = config.enrichment;
  const list = input.list;
  const reuse = await countReusable(userId, reuseJobFor(userId, sheetId, input, prepared.ok));
  const est = await estimateEnrichment(userId, {
    toolId: input.toolId, rows: Math.max(0, upperBound - reuse.rows), preset: input.preset,
    given: Object.keys(input.inputs).sort(),
    skip: input.skipProviders, order: input.providerOrder, stopAtFirst: input.stopAtFirst,
    maxCostPerRowUsd: e.maxCostPerRowUsd, limit: null,
    list: list ? { provider: list.provider, maxItems: list.maxItems, destSheetId: listPlan?.sheetId ?? null } : null,
  });
  if (!('ok' in est)) {
    const upstream = est.fail === 'unreachable' || est.fail === 'upstream';
    return { fail: upstream ? 'upstream' : 'bad_request', message: est.message };
  }
  const { estimate, priceKnown, providersOn } = est.ok;
  const daily = dailyLimitOf(userId);
  const hasKey = !!getTregToken(userId);
  const balance = hasKey ? await readEnrichBalance(userId) : null;
  const notes: string[] = [];
  if (!hasKey) notes.push('No treg key is saved: add one in Cubex Settings before a run can start.');
  if (priceKnown) {
    notes.push('Most rows cost less than max_cost_per_row_usd: the low figure is every row found by the cheapest '
      + 'provider. Rows nobody finds can be free with providers that charge per success; some providers charge '
      + 'for a miss.');
  } else {
    notes.push('This tool has no listed price: it runs on your team\'s own provider key at treg, and that '
      + 'provider bills it, so there are no figures and no run limit.');
  }
  notes.push('rows_to_process counts rows missing an input too; the run skips those and leaves their status empty.');
  if (reuse.rows > 0) {
    notes.push(`${reuse.complete ? '' : 'At least '}${reuse.rows} of these rows reuse a found answer from the last `
      + `${reuse.days} days at $0 (no call); the cost covers the other rows. fresh: true calls every row again.`);
  }
  return {
    ok: {
      estimate_only: true,
      tool: { id: e.toolId, name: e.toolName, kind: e.kind, preset: e.preset },
      status_column: statusColumn, output_columns: outputNames,
      rows_to_process: upperBound, test_rows: e.rows.test,
      // Rows that reuse a found answer at $0 (complete false: a floor, counted for a while on a big run).
      reuse: {
        rows: reuse.rows, complete: reuse.complete, checked_rows: reuse.checked, days: reuse.days, fresh: e.fresh,
      },
      price_known: priceKnown,
      estimated_cost_usd: priceKnown ? { low: estimate.lowUsd, high: estimate.highUsd } : null,
      per_row_usd: priceKnown ? { low: estimate.perRowLowUsd, high: estimate.perRowHighUsd } : null,
      max_cost_per_row_usd: e.maxCostPerRowUsd, spend_limit_usd: e.spendLimitUsd,
      providers_on: providersOn,
      daily_limit: daily,
      may_pass_daily_limit: priceKnown && daily.remaining_usd !== null && estimate.highUsd > daily.remaining_usd,
      ...(balance && 'ok' in balance ? {
        treg_balance_usd: round6(balance.ok.balanceUsd), treg_on_hold_usd: round6(balance.ok.onHoldUsd),
        may_pass_balance: priceKnown && estimate.highUsd > balance.ok.balanceUsd,
      } : {}),
      ...(est.ok.list && listPlan ? {
        list: {
          destination: listPlan.sheetId ? { sheet_id: listPlan.sheetId, name: listPlan.name }
            : { new_sheet_name: listPlan.name },
          adds_up_to_rows: est.ok.list.addUpTo, results_per_row: est.ok.list.perRow,
          destination_rows: est.ok.list.destRows, max_rows: est.ok.list.maxRows,
          fields: listPlan.fields?.map(f => ({ path: f.path, column_name: f.columnName })) ?? null,
        },
      } : {}),
      notes,
    },
  };
}
