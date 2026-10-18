// Run controls in the app (backlog: column run menu, run one cell): the
// column menu's "Run N empty or out-of-date rows", "Force run all N rows" and
// "Retry N failed rows", the header's one-click "N failed, retry", and a
// cell's play button. Each starts the column's own rerun with its newest
// setup, as its kind's menu always did (services/ai-run-rerun.ts,
// http-run-rerun.ts, enrich-rerun.ts, waterfall-rerun.ts); estimates are in
// run-controls-estimate.ts, the numbers in run-controls-counts.ts.
import { rerunAiColumn } from './ai-run-rerun';
import { rerunHttpColumn } from './http-run-rerun';
import { rerunEnrichmentColumn } from './enrich-rerun';
import { rerunWaterfallColumn } from './waterfall-rerun';
import type { RunFail } from './run-shared';
import type { RunColumn, RunKind } from './run-controls-column';
import { enrichRowsOf, modeOf, type RunTarget } from './run-controls-target';

export type RunControlStarted = { ok: { kind: RunKind; runId: string; rows: number } } | RunFail;

// rowGeneration: the sheet's when the row was picked (a sort since refuses it).
// spendLimitUsd: an enrichment's or a waterfall's limit its confirm quoted
// (null: sized to its rows at start, as an agent's rerun is).
export async function startRunControl(
  userId: string, sheetId: string, col: RunColumn, t: RunTarget,
  opts: { rowGeneration: number | null; spendLimitUsd: number | null },
): Promise<RunControlStarted> {
  const rowIndices = 'row' in t ? [t.row] : undefined;
  const mode = 'rows' in t ? modeOf(t) : undefined;
  if (col.kind === 'ai') {
    // The run that owns the main column (a structured run's status column too).
    const out = await rerunAiColumn(userId, {
      sheetId, baseColumnName: col.main.replace(/ \(Output\)$/, ''), columnName: col.main, mode, rowIndices,
    });
    return 'fail' in out ? out : { ok: { kind: 'ai', runId: out.ok.runId, rows: out.ok.targetCount } };
  }
  if (col.kind === 'http') {
    const out = await rerunHttpColumn(userId, { sheetId, masterColumnName: col.main, mode, rowIndices });
    return 'fail' in out ? out : { ok: { kind: 'http', runId: out.ok.runId, rows: out.ok.targetCount } };
  }
  const rows = enrichRowsOf(t);
  if (col.kind === 'enrichment') {
    const out = await rerunEnrichmentColumn(userId, sheetId, {
      column: col.main, rows, estimateOnly: false, spendLimitUsd: opts.spendLimitUsd, rowGeneration: opts.rowGeneration,
    });
    if ('fail' in out) return out;
    if (!('runId' in out.ok)) return { fail: 'bad_request', message: 'The run didn\'t start.' };
    return { ok: { kind: 'enrichment', runId: out.ok.runId, rows: out.ok.rowsInScope } };
  }
  const out = await rerunWaterfallColumn(userId, sheetId, {
    column: col.main, status: rows.status, rowIndexes: rows.rowIndexes, test: null, rowGeneration: opts.rowGeneration,
    fresh: false, noReuse: false, spendLimitUsd: opts.spendLimitUsd,
  }, { estimateOnly: false, hasSecretsScope: true });
  if ('fail' in out) return out;
  if (!('started' in out.ok)) return { fail: 'bad_request', message: 'The run didn\'t start.' };
  return { ok: { kind: 'waterfall', runId: out.ok.started.runId, rows: out.ok.started.rowsInScope } };
}
