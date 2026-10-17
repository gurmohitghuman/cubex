// What carrying a column of the sheet on would take (setup-estimate.ts): the
// rows its run would take (an AI column's empty rows, an HTTP API column's
// missing rows, an enrichment's rows not enriched yet; of the test rows, in a
// test; a row its rule kept out only if the rule passes on it now), priced
// with the column's own settings. A clean or formula column is free: it
// follows its columns, or it's filled again. A pure read.
import { mainColumn, type SetupStep } from '../lib/setups/spec';
import { countRerunTargets, httpCellMissing } from './rerun-targets';
import { resolveRerunTargets } from './ai-rerun-modes';
import { rerunEnrichmentColumn } from './enrich-rerun';
import { columnRunNow, derivedFollows } from './setup-step-again';
import { storedRule } from './run-rule';
import { aiEstimate, round, type StepEstimate } from './setup-estimate';

const DONE = 'Every row is done already: nothing to run.';
const RUN_NOW = {
  active: 'A run on it is working now: it carries on once that run ends.',
  paused: 'A run on it is paused: resume or stop it first, or the setup stops at this step.',
} as const;
const notes = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ') || null;

export async function estimateAgain(
  userId: string, sheetId: string, own: SetupStep, base: StepEstimate,
  ctx: { sheetColumns: string[]; made: string[]; rowIndexes: number[] | null },
): Promise<StepEstimate> {
  const main = mainColumn(own);
  const scope = ctx.rowIndexes ? { withinRows: ctx.rowIndexes } : {};
  const nothing: StepEstimate = { ...base, rows: 0, low_usd: 0, high_usd: 0, note: DONE };
  if (own.kind === 'clean' || own.kind === 'formula') {
    return { ...base, free: true, note: derivedFollows(sheetId, userId, own.kind, main)
      ? 'Follows its columns: works out the new and changed rows.' : 'Fills every row again.' };
  }
  const runNow = columnRunNow(sheetId, userId, own.kind === 'ai' ? 'ai' : 'http', main);
  const running = runNow ? RUN_NOW[runNow] : null;
  const rule = storedRule(sheetId, userId, own.runIf);
  const keptOut = 'ok' in rule ? rule.ok : null;
  if (own.kind === 'http') {
    const rows = await countRerunTargets(sheetId, userId, main, httpCellMissing, scope, keptOut);
    if (!rows) return nothing;
    return { ...base, rows, sends_requests: true, note: notes('Sends one request a row it hasn\'t done.', running) };
  }
  if (own.kind === 'enrichment') {
    const out = await rerunEnrichmentColumn(userId, sheetId, {
      column: main, estimateOnly: true, spendLimitUsd: null, rowGeneration: null,
      rows: ctx.rowIndexes
        ? { mode: 'selected', status: 'not_enriched', test: null, rowIndexes: ctx.rowIndexes }
        : { mode: 'all', status: 'not_enriched', test: null, rowIndexes: null },
    });
    if ('fail' in out) return out.nothingToRun ? nothing : { ...base, note: out.message };
    if (!('estimate' in out.ok)) return { ...base, note: 'It couldn\'t be priced.' };
    const e = out.ok.estimate;
    if (!e.rows) return nothing;
    if (!e.priceKnown) {
      return { ...base, rows: e.rows, note: notes('Billed by the provider on your own key.', running) };
    }
    return { ...base, rows: e.rows, low_usd: round(e.lowUsd), high_usd: round(e.highUsd), note: notes(running) };
  }
  const targets = await resolveRerunTargets(sheetId, userId, main, 'empty', scope, keptOut);
  if (!targets.length) return nothing;
  const out = await aiEstimate(userId, sheetId, own, ctx.sheetColumns, ctx.made, targets);
  if ('fail' in out) return out.fail === 'no_rows' ? nothing : { ...base, rows: targets.length, note: out.message };
  const cost = out.ok.estimated_cost_usd;
  return {
    ...base, rows: out.ok.rows_to_process, low_usd: cost ? round(cost.low) : null,
    high_usd: cost ? round(cost.high) : null, note: notes(!cost && 'No price is known for its model.', running),
  };
}
