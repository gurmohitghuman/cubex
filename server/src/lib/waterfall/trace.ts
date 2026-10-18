// One waterfall row's trace and the cells it writes (pure). The trace lists
// the steps the row reached, in order, with what each did; it is stored with
// the row's result (http_results.response_data, under _cubex.waterfall) and
// shown by the trace panel, run results and dry runs. The cells: the result
// column holds the answer or why there is none, the "answered by" column the
// answering step's label, and each step's column its own value or marker, so
// run-state filters work per step (lib/row-filter/cell-status.ts).
import { CELL_MAX_ENRICHMENT, WATERFALL_TRACE_DETAIL_CHARS, WATERFALL_TRACE_VALUE_CHARS } from '../constants';
import { ENRICH_CELL, failedCell, type RowCells } from '../enrich-cells';
import { clampCellChars, stripControlChars } from '../csv-safety';
import type { StepKind, WaterfallStep } from './config';

export type StepOutcome = 'answered' | 'rejected' | 'not_found' | 'no_inputs' | 'error' | 'budget';
// Where a step's answer came from when it wasn't called now (last_run: a
// retry of a failed row replays what its last run paid to find nothing).
export type StepFrom = 'journal' | 'dry_run' | 'reused' | 'same_lookup' | 'last_run';

export interface TraceStep {
  id: string; label: string; kind: StepKind; outcome: StepOutcome;
  value?: string;                  // the answer (or rejected value); what came back that wasn't one
  detail?: string;                 // why the step ended so
  provider?: string;               // the provider a treg waterfall tool used
  cost_usd: number;
  ms: number;
  from?: StepFrom;
  check?: { outcome: 'passed' | 'failed' | 'error'; verdict?: string; cost_usd: number };
}

export interface Trace { v: 1; answered_by: string | null; steps: TraceStep[] }

export const STEP_CELL = { noInputs: '⏭️ No inputs' } as const;

const cut = (s: string, n: number): string => {
  const one = stripControlChars(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
export const traceValue = (s: string): string => cut(s, WATERFALL_TRACE_VALUE_CHARS);
export const traceDetail = (s: string): string => cut(s, WATERFALL_TRACE_DETAIL_CHARS);

// A step's own column.
export function stepCell(t: TraceStep): string {
  switch (t.outcome) {
    case 'answered':
    case 'rejected': return t.value ? clampCellChars(stripControlChars(t.value), CELL_MAX_ENRICHMENT) : '';
    case 'not_found': return ENRICH_CELL.notFound;
    case 'no_inputs': return STEP_CELL.noInputs;
    case 'budget': return ENRICH_CELL.budget;
    default: return failedCell(t.detail || 'The step failed.');
  }
}

// The row's cells (as enrich-cells' RowCells: the result is the status cell,
// the answer object feeds "$.answered_by" and "$.steps.<id>"). Steps the row
// didn't reach (an earlier one answered, or switched off) read ''.
export function rowCells(trace: Trace, steps: readonly WaterfallStep[]): RowCells {
  const byId = new Map(trace.steps.map(t => [t.id, t]));
  const cells: Record<string, string> = {};
  for (const s of steps) {
    const t = byId.get(s.id);
    cells[s.id] = t ? stepCell(t) : '';
  }
  const answered = trace.steps.find(t => t.outcome === 'answered');
  const answer = { answered_by: answered ? answered.label : '', steps: cells };
  if (answered) {
    return { status: 'completed', statusCell: answered.value ?? '', answer, fill: 'all', reason: null };
  }
  const failed = trace.steps.find(t => t.outcome === 'error');
  if (failed) {
    const reason = `${failed.label}: ${failed.detail || 'the step failed'}`;
    return { status: 'failed', statusCell: failedCell(reason), answer, fill: 'all', reason };
  }
  const ran = trace.steps.filter(t => t.outcome !== 'no_inputs');
  if (ran.length === 0) {
    // No step had its inputs: the row reads "not run yet", as an enrichment
    // row missing its inputs does, so a later run or auto-run takes it.
    return { status: 'completed', statusCell: '', answer, fill: 'all', reason: 'No step had the inputs it needs.' };
  }
  const last = ran[ran.length - 1];
  const statusCell = last.outcome === 'budget' ? ENRICH_CELL.budget : ENRICH_CELL.notFound;
  return { status: 'completed', statusCell, answer, fill: 'all', reason: null };
}

// What the row cost this run, from its trace (replays from a dry run or an
// earlier answer cost nothing; the row's own journal was paid by this run).
export function traceCostUsd(trace: Trace): number {
  const micro = trace.steps.reduce((s, t) => s + Math.round((t.cost_usd + (t.check?.cost_usd ?? 0)) * 1e6), 0);
  return micro / 1e6;
}
