// A dry run as the app's panel, REST and MCP read it: the run's progress and
// spend (waterfall-status.ts), and for each of its rows the inputs the steps
// read (from the row as it is now) and every step it reached, in order, with
// what it did, what it found and what it cost. A pure read.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { parseRowData } from '../lib/sql-rows';
import { parseTargetRows } from '../lib/run-targets';
import { rowSteps, waterfallConfigOf, type StepKind } from '../lib/waterfall/config';
import { rowInputs } from '../lib/waterfall/rows';
import type { TraceStep } from '../lib/waterfall/trace';
import { storedTrace } from './waterfall-trace';
import { waterfallRunStatus, type WaterfallRunStatus } from './waterfall-status';

export interface DryRowView {
  row_index: number;
  row_id: string | null;
  inputs: Record<string, string>;      // the non-empty ones
  done: boolean;
  gone: boolean;                       // the row was deleted before the run reached it
  value: string;                       // the answer ('' when none)
  answered_by: string | null;          // the answering step's label
  cost_usd: number | null;
  steps: TraceStep[];                  // the steps it reached, in order
}

export interface DryRunView {
  run: WaterfallRunStatus;
  column: string;                      // the result column it was started for
  only: { id: string; label: string } | null;
  steps: Array<{ id: string; label: string; kind: StepKind }>;   // the steps it walks
  rows: DryRowView[];
}

export function readDryRun(userId: string, runId: string): DryRunView | null {
  const r = db.prepare('SELECT sheet_id, config, target_rows FROM http_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { sheet_id: string; config: string; target_rows: string | null } | undefined;
  const config = waterfallConfigOf(r?.config);
  const dry = config?.waterfall.dry;
  const run = r && dry ? waterfallRunStatus(userId, runId) : null;
  if (!r || !config || !dry || !run) return null;
  const walked = rowSteps(config);
  const label = new Map(walked.map(s => [s.id, s.label]));
  const targets = parseTargetRows(r.target_rows) ?? [];
  const columns = getSheetColumns(r.sheet_id, userId, false);
  const rowAt = db.prepare('SELECT id, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index = ?');
  const resultAt = db.prepare(`SELECT response_data, cost_usd FROM http_results
    WHERE run_id = ? AND row_index = ? AND user_id = ?`);
  const rows = targets.map((rowIndex): DryRowView => {
    const row = rowAt.get(r.sheet_id, userId, rowIndex) as { id: string; data: string } | undefined;
    const inputs = row ? rowInputs(config, parseRowData(row.data), columns) : {};
    const res = resultAt.get(runId, rowIndex, userId) as { response_data: string | null; cost_usd: number | null }
      | undefined;
    const trace = res ? storedTrace(res.response_data) : null;
    const answered = trace?.answered_by ? trace.steps.find(s => s.id === trace.answered_by) : undefined;
    return {
      row_index: rowIndex, row_id: row?.id ?? null,
      inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== '')),
      done: !!trace || !row, gone: !row && !trace, value: answered?.value ?? '',
      answered_by: answered ? label.get(answered.id) ?? answered.label : null,
      cost_usd: res?.cost_usd ?? null, steps: trace?.steps ?? [],
    };
  });
  return {
    run, column: dry.column, only: dry.only ? { id: dry.only, label: label.get(dry.only) ?? dry.only } : null,
    steps: walked.map(s => ({ id: s.id, label: s.label, kind: s.choices.kind })), rows,
  };
}
