// A waterfall cell's trace (GET /api/waterfall/sheets/:id/trace?column=&row=,
// the trace panel): for the newest run with a result at that row (the answer
// panel's walk, services/answer-runs.ts), every step of that run in order with
// what it did for the row: answered, missed, skipped for missing inputs,
// failed, or not reached because an earlier step answered. A pure read.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { parseStored, readStored } from '../lib/answer-store';
import { waterfallConfigOf, type StepKind } from '../lib/waterfall/config';
import { jsonPath } from '../lib/sql-rows';
import { RESULT_INFO } from '../lib/waterfall/result-type';
import type { Trace, TraceStep } from '../lib/waterfall/trace';
import { columnRuns, resultAtRow } from './answer-runs';
import type { RunFail } from './run-shared';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface TraceStepView extends Partial<TraceStep> {
  id: string; label: string; kind: StepKind; on: boolean;
  reached: boolean;                     // false: off, or an earlier step answered
}

export interface WaterfallTraceView {
  column: string; resultColumn: string; rowIndex: number;
  runId: string; runAt: string;
  status: 'completed' | 'failed'; reason: string | null;
  resultType: string;
  value: string;                        // what the result cell shows
  answeredBy: string | null;            // the answering step's label
  costUsd: number | null;               // what this row cost that run
  steps: TraceStepView[];
}

// The trace stored with a row's result (null: not a waterfall result).
export function storedTrace(raw: string | null): Trace | null {
  const body = readStored(parseStored(raw)).body;
  const t = isObj(body) && isObj(body._cubex) ? body._cubex.waterfall : null;
  return isObj(t) && Array.isArray(t.steps) ? t as unknown as Trace : null;
}

export function readWaterfallTrace(
  userId: string, sheetId: string, column: string, rowIndex: number,
): { ok: WaterfallTraceView } | RunFail {
  return db.transaction((): { ok: WaterfallTraceView } | RunFail => {
    if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
    const owner = columnRuns(sheetId, userId, column);
    if (!owner) return { fail: 'bad_request', message: `"${column}" isn't a waterfall column.` };
    const hit = resultAtRow(owner.runs, userId, rowIndex);
    if (!hit) return { fail: 'not_found', message: 'This row has no result yet.' };
    const config = waterfallConfigOf(JSON.stringify(hit.run.config));
    const trace = storedTrace(hit.response_data);
    if (!config || !trace) return { fail: 'bad_request', message: `"${column}" isn't a waterfall column.` };
    const cell = db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE sheet_id = ? AND user_id = ?
      AND row_index = ?`).pluck().get(jsonPath(owner.statusColumn), sheetId, userId, rowIndex);
    const byId = new Map(trace.steps.map(s => [s.id, s]));
    const steps: TraceStepView[] = config.waterfall.steps.map(s => {
      const t = byId.get(s.id);
      if (t) return { ...t, on: s.on, reached: true };
      return { id: s.id, label: s.label, kind: s.choices.kind, on: s.on, reached: false };
    });
    const answered = trace.answered_by ? byId.get(trace.answered_by) : undefined;
    return {
      ok: {
        column, resultColumn: owner.statusColumn, rowIndex, runId: hit.run.id, runAt: hit.run.createdAt,
        status: hit.status === 'failed' ? 'failed' : 'completed', reason: hit.error_message,
        resultType: RESULT_INFO[config.waterfall.resultType].label,
        value: typeof cell === 'string' ? cell : cell === null || cell === undefined ? '' : String(cell),
        answeredBy: answered?.label ?? null, costUsd: hit.cost_usd, steps,
      },
    };
  })();
}
