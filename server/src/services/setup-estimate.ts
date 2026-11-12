// What using a setup on a sheet could cost, step by step, before anything
// starts (a pure read). AI steps are priced by the AI estimate and enrichments
// by treg's prices, on the rows the setup takes; HTTP API steps send a request
// a row and cost nothing here; clean and formula steps are free. A later step
// can't see the values earlier steps will write: an AI prompt reading them is
// priced as if each held a few words (so a long value makes it cost more),
// and a rule reading them is left out (so every row counts). An AI step also
// says one row's most (row_most_usd), which its run's spend limit keeps room
// for: a ceiling must cover that on top of the high ends. A step carrying
// a column of the sheet on is priced on the rows it hasn't done, with the
// column's own settings (setup-estimate-again.ts).
import { COLUMN_REF_PATTERN } from '../lib/prompt';
import { resolveAiConcurrency } from '../lib/ai-model-resolve';
import { ruleColumns } from '../lib/run-condition';
import { columnLookup } from '../lib/setups/refs';
import { mainColumn, stepColumns, type AiStep, type SetupSpec, type StepKind } from '../lib/setups/spec';
import type { SheetColumnStep, StepMode } from '../lib/setups/again';
import type { SearchOptions } from '../lib/web-search-options';
import { estimateAiRun } from './run-estimate';
import { estimateEnrichment } from './enrich-setup';
import { estimateAgain } from './setup-estimate-again';

export interface StepEstimate {
  column: string; kind: StepKind; layer: number; mode: StepMode;
  rows: number;
  // A range in dollars; null when it costs nothing here (free, or an HTTP API's own bill) or has no price.
  low_usd: number | null; high_usd: number | null;
  // An AI step's most for one row, which its run's spend limit keeps room for (run-estimate.ts); else null.
  row_most_usd: number | null;
  sends_requests: boolean; free: boolean;
  note: string | null;
}
export interface SetupEstimate {
  rows: number; low_usd: number; high_usd: number;
  // One row's most for each priced AI step, summed: what the ceiling holds on top of high_usd.
  row_most_usd: number;
  unpriced: string[];  // steps that cost something no price is known for
  steps: StepEstimate[];
}

const EARLIER_VALUE = 'a value an earlier step writes';
export const round = (n: number) => Math.round(n * 1e4) / 1e4;
// Rounded up, so the room kept is never less than the run's spend limit asks for.
export const rowMostOf = (e: { row_most_usd: number | null }) =>
  (e.row_most_usd === null ? null : Math.ceil(e.row_most_usd * 1e6 - 1e-6) / 1e6);

// A rule reading a column the setup writes (made new, or carried on) is left out: those values will change.
export async function aiEstimate(
  userId: string, sheetId: string, s: AiStep, sheetColumns: string[], made: string[], rowIndexes: number[] | null,
) {
  const later = columnLookup(made);
  const prompt = s.prompt.replace(COLUMN_REF_PATTERN, (full, token: string) =>
    (later.prompt(token) !== undefined ? EARLIER_VALUE : full));
  const ruleOk = !s.runIf || ruleColumns(s.runIf).every(c => sheetColumns.includes(c) && !made.includes(c));
  return estimateAiRun(userId, {
    sheetId, prompt, systemPrompt: s.systemPrompt ?? undefined, model: s.model ?? undefined,
    useOpenRouterWebSearch: s.webSearch, useWebFetch: s.webFetch, outputColumns: s.outputColumns ?? undefined,
    maxChars: s.maxChars, targetRowIndexes: rowIndexes ?? undefined, search: s.search as SearchOptions | null,
    runIf: ruleOk ? s.runIf : null, concurrency: resolveAiConcurrency(s.concurrency ?? undefined, sheetId, userId),
    // History is found by the prompt as the step's start stores it, not the one rewritten for pricing.
    fetchLimits: s.fetchLimits, historyColumn: mainColumn(s), historyPrompt: s.prompt,
  });
}

export async function estimateSetup(
  userId: string, sheetId: string, plan: { spec: SetupSpec; layers: number[]; modes: StepMode[] },
  sheetColumns: string[], rows: number, rowIndexes: number[] | null, existing: SheetColumnStep[],
): Promise<SetupEstimate> {
  const made = plan.spec.steps.flatMap(stepColumns);
  const steps: StepEstimate[] = [];
  for (const [i, s] of plan.spec.steps.entries()) {
    const base = { column: mainColumn(s), kind: s.kind, layer: plan.layers[i] + 1, mode: plan.modes[i], rows,
      note: null, low_usd: null, high_usd: null, row_most_usd: null, sends_requests: false, free: false };
    const own = plan.modes[i] === 'again' ? existing.find(c => c.columns[0] === base.column)?.step : undefined;
    if (own) {
      steps.push(await estimateAgain(userId, sheetId, own, base, { sheetColumns, made, rowIndexes }));
      continue;
    }
    if (s.kind === 'clean' || s.kind === 'formula') { steps.push({ ...base, free: true }); continue; }
    if (s.kind === 'http') {
      steps.push({ ...base, sends_requests: true, note: 'Sends one request a row to its API.' });
      continue;
    }
    if (s.kind === 'enrichment') {
      const out = await estimateEnrichment(userId, {
        toolId: s.toolId, rows, preset: s.preset, given: Object.keys(s.inputs).sort(), skip: s.skipProviders,
        order: s.providerOrder, stopAtFirst: s.stopAtFirst, maxCostPerRowUsd: s.maxCostPerRowUsd, limit: null,
        list: null,
      });
      if (!('ok' in out)) steps.push({ ...base, note: out.message });
      else if (!out.ok.priceKnown) steps.push({ ...base, note: 'Billed by the provider on your own key.' });
      else steps.push({ ...base, low_usd: round(out.ok.estimate.lowUsd), high_usd: round(out.ok.estimate.highUsd) });
      continue;
    }
    const out = await aiEstimate(userId, sheetId, s, sheetColumns, made, rowIndexes);
    if ('fail' in out) { steps.push({ ...base, note: out.message }); continue; }
    const cost = out.ok.estimated_cost_usd;
    steps.push({
      ...base, rows: out.ok.rows_to_process, low_usd: cost ? round(cost.low) : null,
      high_usd: cost ? round(cost.high) : null, row_most_usd: cost ? rowMostOf(out.ok) : null,
      note: [cost ? null : 'No price is known for its model.', out.fetchNote].filter(Boolean).join(' ') || null,
    });
  }
  const priced = steps.filter(s => s.low_usd !== null);
  return {
    rows, steps,
    row_most_usd: Math.ceil(priced.reduce((n, s) => n + (s.row_most_usd ?? 0), 0) * 1e6 - 1e-6) / 1e6,
    low_usd: round(priced.reduce((n, s) => n + s.low_usd!, 0)),
    high_usd: round(priced.reduce((n, s) => n + s.high_usd!, 0)),
    unpriced: steps.filter(s => s.low_usd === null && !s.free && !s.sends_requests).map(s => s.column),
  };
}
