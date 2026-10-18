// What a waterfall run costs before it starts: the average and the most per
// row, and for the rows in scope (lib/waterfall/estimate.ts), step by step:
// how many rows reach each step, what it costs when reached, how often it
// answers and where that rate comes from (this column's newest runs, treg's
// observed hit rate, or unknown: counted as never answering, so the average
// errs high). A pure read: the same checks as a start (services/
// waterfall-run-prepare.ts), nothing written.
import { db } from '../lib/db';
import { WATERFALL_RATE_MIN_ROWS, WATERFALL_RATE_RUNS } from '../lib/constants';
import { enrichmentStepCost, rowEstimate, withCheck, withHistory, type StepCost } from '../lib/waterfall/estimate';
import { tallyKey } from '../lib/waterfall/keys';
import { usesTreg } from '../lib/waterfall/caps';
import { RESULT_INFO } from '../lib/waterfall/result-type';
import type { WaterfallBlock, WaterfallRunConfig, WaterfallStep } from '../lib/waterfall/config';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { dailyLimitView } from './treg-key';
import { prepareWaterfallStart } from './waterfall-run-prepare';
import type { BuiltWaterfall } from './waterfall-build';
import type { RunFail } from './run-shared';

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface StepEstimateView {
  id: string; label: string; kind: string; on: boolean;
  reach: number | null;                 // share of rows reaching it (null: switched off)
  max_usd: number; expected_usd: number;
  answer_rate: number | null; rate_from: 'history' | 'treg' | null;
}

export interface WaterfallEstimate {
  result_type: string;
  rows: number;
  per_row: { average_usd: number; max_usd: number };
  total: { average_usd: number; max_usd: number };
  run_limit_usd: number | null;
  steps: StepEstimateView[];
  daily_limit: ReturnType<typeof dailyLimitView> | null;   // today's enrichment limit, when a treg step is on
  notes: string[];
}

// Answer rates of this column's newest runs, per step setup (step_key).
type Rates = Map<string, { reached: number; answered: number; rejected: number }>;

function historyOf(sheetId: string, userId: string, column: string): Rates {
  const rows = db.prepare(`SELECT t.step_key AS k, SUM(t.reached) AS reached, SUM(t.answered) AS answered,
      SUM(t.rejected) AS rejected FROM waterfall_step_tally t WHERE t.user_id = ? AND t.run_id IN (
      SELECT h.id FROM http_runs h WHERE h.sheet_id = ? AND h.master_column_name = ? AND +h.user_id = ?
      ORDER BY h.created_at DESC LIMIT ?)
    GROUP BY t.step_key`).all(userId, sheetId, column, userId, WATERFALL_RATE_RUNS) as
    Array<{ k: string; reached: number; answered: number; rejected: number }>;
  return new Map(rows.map(r => [r.k, { reached: r.reached, answered: r.answered, rejected: r.rejected }]));
}

// A step's cost as the estimate counts it: its own, this column's answer rate, its check.
function finalCost(w: WaterfallBlock, s: WaterfallStep, base: StepCost, history: Rates): StepCost {
  const h = history.get(tallyKey(w, s)) ?? null;
  const known = h && h.reached >= WATERFALL_RATE_MIN_ROWS ? h : null;
  const cost = withHistory(base, h, WATERFALL_RATE_MIN_ROWS);
  if (!s.check) return cost;
  const usd = s.check.built.kind === 'verify' ? s.check.built.capUsd ?? 0 : 0;
  return withCheck(cost, {
    usd, preRate: base.answerRate, found: known ? (known.answered + known.rejected) / known.reached : null,
  });
}

function stepCost(w: WaterfallBlock, s: WaterfallStep, built: BuiltWaterfall): StepCost {
  const b = s.built;
  if (b.kind === 'enrichment') {
    const t = built.tools.get(s.id);
    if (t) return enrichmentStepCost(t.tool, t.pick, b.capUsd);
    return { maxUsd: b.capUsd ?? 0, expectedUsd: b.capUsd ?? 0, answerRate: null, rateFrom: null };
  }
  if (b.kind === 'ai') return { maxUsd: b.capUsd, expectedUsd: b.lowUsd, answerRate: null, rateFrom: null };
  return { maxUsd: 0, expectedUsd: 0, answerRate: null, rateFrom: null };
}

export async function estimateWaterfall(
  userId: string, sheetId: string, input: WaterfallRunInput,
): Promise<{ ok: WaterfallEstimate } | RunFail> {
  const prepared = await prepareWaterfallStart(userId, sheetId, input);
  if ('fail' in prepared) return prepared;
  const p = prepared.ok;
  const w = p.config.waterfall;
  const history = historyOf(sheetId, userId, p.resultColumn);
  const on = w.steps.filter(s => s.on);
  const costs = on.map(s => ({
    id: s.id, ...finalCost(w, s, stepCost(w, s, p.built), history),
  }));
  const row = rowEstimate(costs);
  const byId = new Map(row.steps.map(s => [s.id, s]));
  const notes: string[] = [
    'The average assumes each step answers as often as this column\'s earlier runs, or treg, have seen it answer; '
      + 'a step with no record counts as never answering, so the real cost is usually lower.',
  ];
  if (on.some(s => s.built.kind === 'enrichment')) {
    notes.push('Rows whose lookup an earlier run already found cost nothing (answers are reused), so they cost less.');
  }
  if (on.some(s => s.built.kind === 'enrichment' && s.built.capUsd === null)) {
    notes.push('A step runs on your own provider key: the provider bills it, so it isn\'t counted here.');
  }
  for (const s of on) {
    const a = p.built.ai.get(s.id);
    if (a?.note) notes.push(`${s.label}: ${a.note}`);
  }
  if (on.some(s => s.built.kind === 'http')) {
    notes.push('HTTP API steps call your own API: whatever it charges is billed there, not counted here.');
  }
  // A step switched off reaches no row, but its own cost still shows (its Test runs it).
  const steps: StepEstimateView[] = w.steps.map(s => {
    const e = byId.get(s.id) ?? { ...finalCost(w, s, stepCost(w, s, p.built), history), reach: null };
    return {
      id: s.id, label: s.label, kind: s.choices.kind, on: s.on, reach: e.reach,
      max_usd: round6(e.maxUsd), expected_usd: round6(e.expectedUsd),
      answer_rate: e.answerRate ?? null, rate_from: e.rateFrom ?? null,
    };
  });
  const rows = p.upperBound;
  return {
    ok: {
      result_type: RESULT_INFO[w.resultType].label, rows,
      per_row: { average_usd: row.avgUsd, max_usd: row.maxUsd },
      total: { average_usd: round6(row.avgUsd * rows), max_usd: round6(row.maxUsd * rows) },
      run_limit_usd: w.spendLimitUsd, steps,
      daily_limit: on.some(usesTreg) ? dailyLimitView(userId) : null,
      notes,
    },
  };
}

// A stored waterfall's average and most per row without reading the catalog
// (auto-run's notices): each step's cap, an AI step's typical call, and the
// column's own answer rates where its runs have them.
export function storedRowEstimate(
  sheetId: string, userId: string, column: string, config: WaterfallRunConfig,
): { avgUsd: number; maxUsd: number } {
  const w = config.waterfall;
  const history = historyOf(sheetId, userId, column);
  const costs = w.steps.filter(s => s.on).map(s => {
    const b = s.built;
    const base: StepCost = b.kind === 'enrichment'
      ? { maxUsd: b.capUsd ?? 0, expectedUsd: b.capUsd ?? 0, answerRate: null, rateFrom: null }
      : b.kind === 'ai' ? { maxUsd: b.capUsd, expectedUsd: b.lowUsd, answerRate: null, rateFrom: null }
        : { maxUsd: 0, expectedUsd: 0, answerRate: null, rateFrom: null };
    return { id: s.id, ...finalCost(w, s, base, history) };
  });
  const r = rowEstimate(costs);
  return { avgUsd: r.avgUsd, maxUsd: r.maxUsd };
}
