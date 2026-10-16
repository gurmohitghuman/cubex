// What using a setup on a sheet could cost, step by step, before anything
// starts (a pure read). AI steps are priced by the AI estimate and enrichments
// by treg's prices, on the rows the setup takes; HTTP API steps send a request
// a row and cost nothing here; clean and formula steps are free. A later step
// can't see the values earlier steps will write: an AI prompt reading them is
// priced as if each held a few words, and a rule reading them is left out, so
// those figures are the most it would take, not what it will.
import { COLUMN_REF_PATTERN } from '../lib/prompt';
import { resolveAiConcurrency } from '../lib/ai-model-resolve';
import { ruleColumns } from '../lib/run-condition';
import { columnLookup } from '../lib/setups/refs';
import { mainColumn, stepColumns, type AiStep, type SetupSpec, type StepKind } from '../lib/setups/spec';
import type { SearchOptions } from '../lib/web-search-options';
import { estimateAiRun } from './run-estimate';
import { estimateEnrichment } from './enrich-setup';

export interface StepEstimate {
  column: string; kind: StepKind; layer: number;
  rows: number;
  // A range in dollars; null when it costs nothing here (free, or an HTTP API's own bill) or has no price.
  low_usd: number | null; high_usd: number | null;
  sends_requests: boolean; free: boolean;
  note: string | null;
}
export interface SetupEstimate {
  rows: number; low_usd: number; high_usd: number;
  unpriced: string[];  // steps that cost something no price is known for
  steps: StepEstimate[];
}

const EARLIER_VALUE = 'a value an earlier step writes';
const round = (n: number) => Math.round(n * 1e4) / 1e4;

async function aiEstimate(
  userId: string, sheetId: string, s: AiStep, sheetColumns: string[], made: string[], rowIndexes: number[] | null,
) {
  const later = columnLookup(made);
  const prompt = s.prompt.replace(COLUMN_REF_PATTERN, (full, token: string) =>
    (later.prompt(token) !== undefined ? EARLIER_VALUE : full));
  const ruleOk = !s.runIf || ruleColumns(s.runIf).every(c => sheetColumns.includes(c));
  return estimateAiRun(userId, {
    sheetId, prompt, systemPrompt: s.systemPrompt ?? undefined, model: s.model ?? undefined,
    useOpenRouterWebSearch: s.webSearch, useWebFetch: s.webFetch, outputColumns: s.outputColumns ?? undefined,
    maxChars: s.maxChars, targetRowIndexes: rowIndexes ?? undefined, search: s.search as SearchOptions | null,
    runIf: ruleOk ? s.runIf : null, concurrency: resolveAiConcurrency(s.concurrency ?? undefined, sheetId, userId),
  });
}

export async function estimateSetup(
  userId: string, sheetId: string, plan: { spec: SetupSpec; layers: number[] },
  sheetColumns: string[], rows: number, rowIndexes: number[] | null,
): Promise<SetupEstimate> {
  const made = plan.spec.steps.flatMap(stepColumns);
  const steps: StepEstimate[] = [];
  for (const [i, s] of plan.spec.steps.entries()) {
    const base = { column: mainColumn(s), kind: s.kind, layer: plan.layers[i] + 1, rows, note: null,
      low_usd: null, high_usd: null, sends_requests: false, free: false };
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
      high_usd: cost ? round(cost.high) : null, note: cost ? null : 'No price is known for its model.',
    });
  }
  const priced = steps.filter(s => s.low_usd !== null);
  return {
    rows, steps,
    low_usd: round(priced.reduce((n, s) => n + s.low_usd!, 0)),
    high_usd: round(priced.reduce((n, s) => n + s.high_usd!, 0)),
    unpriced: steps.filter(s => s.low_usd === null && !s.free && !s.sends_requests).map(s => s.column),
  };
}
