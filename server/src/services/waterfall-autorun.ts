// Auto-run for a waterfall column: each batch is a run REBUILT from the
// column's newest choices against treg's catalog and the AI prices as they are
// now (a retired tool pauses auto-run, as an enrichment's does), with
// auto-run's own "Only run if" and a run limit of what's left of the column's
// daily cap. A waterfall with a paid step (treg or AI) has a dollar cap a day,
// one with only free steps (HTTP, formula, lookup) a number of rows a day, as
// an HTTP API column. Today's enrichment limit counts its treg part.
import { AUTORUN_HTTP_DEFAULT_DAILY_ROWS, AUTORUN_MAX_ROWS } from '../lib/constants';
import { limitReached, rowsThatFit } from '../lib/enrich-estimate';
import { getSheetColumns } from '../lib/sql-helpers';
import { onSteps, type WaterfallRunConfig } from '../lib/waterfall/config';
import { dayCapOf, isPaidStep, tregPart } from '../lib/waterfall/caps';
import { getDailyLimitMicro, spentTodayMicro } from './treg-key';
import { heldMicro } from './enrich-holds';
import { buildWaterfall } from './waterfall-build';
import { recallInput } from './waterfall-column';
import { sampleRows } from './waterfall-run-prepare';
import type { AutorunEntry } from './autorun-entry';

const money = (usd: number) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// A waterfall spends money when a step that's on calls treg or an AI model, or checks with treg's verify.
export const waterfallIsPaid = (config: WaterfallRunConfig): boolean => onSteps(config.waterfall).some(isPaidStep);

// Its steps cost money but none has a known price (own provider keys): no dollar cap to ask for.
export const waterfallUnpriced = (config: WaterfallRunConfig): boolean =>
  waterfallIsPaid(config) && config.waterfall.maxCostPerRowUsd === 0;

export type WaterfallPrepared =
  | { ok: { config: WaterfallRunConfig; outputs: string[] } }
  | { pause: { reason: string; message: string } };

export async function prepareWaterfallAutorun(
  e: AutorunEntry, newest: WaterfallRunConfig, rows: number, runLimitUsd: number | null,
): Promise<WaterfallPrepared> {
  // Built without the batch's limit, so a row priced above what's left today (prices rose since
  // the capacity read the stored max) waits instead of reading as a setup problem. Its pause is
  // tried again every few minutes (capacity, reading the stored max, would lift it at once).
  const input = { ...recallInput(newest, e.status_column), runIf: e.run_if, spendLimitUsd: null };
  const columns = getSheetColumns(e.sheet_id, e.user_id, false);
  const built = await buildWaterfall(input, {
    userId: e.user_id, sheetId: e.sheet_id, columns, sample: sampleRows(e.sheet_id, e.user_id), rowsUpperBound: rows,
  });
  if ('fail' in built) {
    const retired = /Pick another tool/.test(built.message);
    const reason = built.fail === 'upstream' ? 'unreachable' : retired ? 'retired' : 'setup';
    return { pause: { reason, message: `${built.message} Edit the waterfall, then turn auto-run on again.` } };
  }
  const most = built.ok.block.maxCostPerRowUsd;
  if (runLimitUsd !== null && most > 0 && runLimitUsd + 1e-6 < most) {
    return {
      pause: {
        reason: 'over_cap',
        message: `Today's cap for this column has ${money(runLimitUsd)} left, less than a row can cost now `
          + `(${money(most)}). Raise the cap, or it goes on tomorrow.`,
      },
    };
  }
  const block = { ...built.ok.block, spendLimitUsd: runLimitUsd ?? built.ok.block.spendLimitUsd };
  const config: WaterfallRunConfig = {
    ...newest, requestConfig: { ...newest.requestConfig, body: JSON.stringify(built.ok.inputMap) },
    ...(e.run_if ? { runIf: e.run_if } : {}), waterfall: block,
  };
  if (!e.run_if) delete config.runIf;
  return { ok: { config, outputs: config.responseMapping.map(m => m.columnName) } };
}

export type WaterfallCapacity =
  | { rows: number; runLimitUsd: number | null }
  | { reason: string; message: string };

// How many rows an auto-run batch may take now, or why none.
export function waterfallCapacity(
  e: AutorunEntry, config: WaterfallRunConfig, used: { spentMicro: number; aiUsd: number; rows: number },
): WaterfallCapacity {
  if (!waterfallIsPaid(config)) {
    const cap = e.daily_row_cap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS;
    const left = cap - used.rows;
    if (left < 1) {
      return { reason: 'row_cap', message: `It ran ${cap.toLocaleString('en-US')} rows today, its most a day.` };
    }
    return { rows: Math.min(left, AUTORUN_MAX_ROWS), runLimitUsd: null };
  }
  const w = config.waterfall;
  const perRow = w.maxCostPerRowUsd > 0 ? w.maxCostPerRowUsd : null;
  const treg = w.tregCapPerRowUsd;
  // Today's enrichment limit whenever a treg step runs; one with no price stops it on what treg charged.
  const part = tregPart(config);
  const limit = part.any ? getDailyLimitMicro(e.user_id) : null;
  const today = limit === null ? 0 : spentTodayMicro(e.user_id) / 1e6;
  if (limit !== null && limitReached(limit / 1e6, today, dayCapOf(treg, part.unpriced))) {
    return { reason: 'daily_limit', message: `Today's ${money(limit / 1e6)} enrichment limit is reached.` };
  }
  const capUsd = e.daily_cap_micro === null ? null : e.daily_cap_micro / 1e6;
  const spentUsd = used.spentMicro / 1e6 + used.aiUsd;
  if (limitReached(capUsd, spentUsd, perRow)) {
    return { reason: 'column_cap', message: `It reached today's ${money(capUsd ?? 0)} cap for this column.` };
  }
  if (perRow === null) {
    return { rows: AUTORUN_MAX_ROWS, runLimitUsd: capUsd === null ? null : round6(capUsd - spentUsd) };
  }
  const byDay = limit === null ? Infinity
    : Math.max(1, rowsThatFit(limit / 1e6, today + heldMicro(e.user_id) / 1e6, treg));
  const byCap = rowsThatFit(capUsd, spentUsd, perRow);
  return {
    rows: Math.min(byCap, byDay, AUTORUN_MAX_ROWS),
    runLimitUsd: capUsd === null ? null : round6(Math.max(0, capUsd - spentUsd)),
  };
}
