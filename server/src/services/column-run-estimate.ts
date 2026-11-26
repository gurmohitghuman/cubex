// What a column run could cost, column by column, before anything starts (a
// pure read; services/column-run.ts). Each column is priced as its column
// menu prices a rerun (run-controls-estimate.ts): on the rows its mode picks
// among the chosen ones, with its own newest setup. A column after another
// chosen column, in an out-of-date mode, may take more rows than are out of
// date now (the earlier run can change what it reads): priced at most, over
// its own rows plus the rows those earlier columns take, at its price for
// every row in scope. A column whose "Only run if" reads a column the run
// changes is counted on the rows its rule passes now, and says so (its run's
// spend limit still holds it to the ceiling).
import { db } from '../lib/db';
import { estimateRunControl, type RunControlEstimate } from './run-controls-estimate';
import { ROWS } from './column-run-step';
import type { ColumnRunMode } from './column-run-input';
import type { ColumnRunPlanned } from './column-run-plan';
import type { RunFail } from './run-shared';
import type { RunKind } from './run-controls-column';
import type { SetupCeiling } from './setup-ceiling';
import type { CeilingFigures } from '../lib/cost-ceiling';

export interface ColumnEstimate {
  column: string; kind: RunKind; layer: number; rows: number;
  // A range in dollars; null when Cubex has no price for it (an HTTP API, a provider on your own key, a model).
  low_usd: number | null; high_usd: number | null;
  // An AI column's most for one row, which its run's spend limit keeps room for; else null.
  row_most_usd: number | null;
  sends_requests: boolean; // an HTTP API column: one request a row, no price here
  at_most: boolean;        // priced over more rows than it takes now (see above)
  note: string | null;
}
export interface ColumnRunEstimate {
  rows_in_scope: number;
  low_usd: number; high_usd: number;
  row_most_usd: number; // summed over the priced AI columns: what a ceiling keeps on top of high_usd
  unpriced: string[];   // columns that cost something no price is known for
  columns: ColumnEstimate[];
}

const STALE: ReadonlySet<ColumnRunMode> = new Set(['out_of_date', 'empty_or_out_of_date']);
const round = (n: number) => Math.round(n * 1e4) / 1e4;
const notes = (...parts: Array<string | null | false>) => parts.filter(Boolean).join(' ') || null;

// layer: 1-based, as get_run (action setup) shows it and a setup's estimate does.
const zero = (c: { column: string; kind: RunKind; layer: number }): ColumnEstimate => ({
  column: c.column, kind: c.kind, layer: c.layer + 1, rows: 0, low_usd: 0, high_usd: 0, row_most_usd: null,
  sends_requests: c.kind === 'http', at_most: false, note: 'No row needs it now.',
});

function viewOf(c: { column: string; layer: number }, e: RunControlEstimate): ColumnEstimate {
  const http = e.kind === 'http';
  return {
    column: c.column, kind: e.kind, layer: c.layer + 1, rows: e.rows,
    low_usd: http || e.lowUsd === null ? null : round(e.lowUsd),
    high_usd: http || e.highUsd === null ? null : round(e.highUsd),
    // An HTTP API column's note only says it sends a request a row with no price: sends_requests says that.
    row_most_usd: e.rowMostUsd ?? null, sends_requests: http, at_most: false, note: http ? null : e.note,
  };
}

// within: the chosen rows' places (null: every row of the sheet).
export async function estimateColumnRun(
  userId: string, sheetId: string, plan: ColumnRunPlanned, mode: ColumnRunMode, within: number[] | null,
): Promise<{ ok: ColumnRunEstimate } | RunFail> {
  const inScope = within?.length
    ?? db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
      .get(sheetId, userId) as number;
  const out: ColumnEstimate[] = [];
  const price = async (i: number, rows: typeof ROWS[ColumnRunMode]) => {
    const c = plan.columns[i];
    return estimateRunControl(userId, sheetId, { kind: c.kind, main: c.column }, { rows, within }, null);
  };
  // Each column after the ones it waits for (layer order), so their rows are known.
  const order = plan.columns.map((_, i) => i).sort((a, b) => plan.columns[a].layer - plan.columns[b].layer);
  const rowsOf = new Map<number, number>();
  for (const i of order) {
    const c = plan.columns[i];
    const own = await price(i, ROWS[mode]);
    if ('fail' in own && !own.nothingToRun) return own;
    let est = 'ok' in own ? viewOf(c, own.ok) : zero(c);
    // The rows the columns it waits for take, directly or further back.
    const before = new Set<number>();
    const walk = (j: number) => plan.columns[j].waitsFor.forEach(k => {
      if (!before.has(k)) { before.add(k); walk(k); }
    });
    walk(i);
    const earlier = [...before].reduce((sum, k) => sum + (rowsOf.get(k) ?? 0), 0);
    if (STALE.has(mode) && earlier > 0 && est.rows < inScope) {
      const all = await price(i, 'all');
      if ('fail' in all && !all.nothingToRun) return all;
      if ('ok' in all && all.ok.rows > est.rows) {
        const rows = Math.min(all.ok.rows, est.rows + earlier);
        const share = rows / all.ok.rows;
        const high = all.ok.highUsd === null || est.sends_requests ? null : round(all.ok.highUsd * share);
        est = { ...est, rows, high_usd: high, row_most_usd: all.ok.rowMostUsd ?? est.row_most_usd, at_most: true,
          note: notes(`At most: the columns before it may change what it reads on up to ${earlier.toLocaleString(
            'en-US')} rows.`, est.note) };
      }
    }
    if (c.ruleReads.some(r => plan.changes.includes(r))) {
      est = { ...est, note: notes(est.note, 'Its "Only run if" reads columns this run changes: it may take more '
        + 'rows than this, up to its spend limit.') };
    }
    rowsOf.set(i, est.rows);
    out[i] = est;
  }
  const priced = out.filter(c => c.high_usd !== null);
  return {
    ok: {
      rows_in_scope: inScope,
      low_usd: round(priced.reduce((s, c) => s + (c.low_usd ?? 0), 0)),
      high_usd: round(priced.reduce((s, c) => s + (c.high_usd ?? 0), 0)),
      row_most_usd: round(priced.reduce((s, c) => s + (c.row_most_usd ?? 0), 0)),
      unpriced: out.filter(c => c.rows > 0 && !c.sends_requests && c.high_usd === null).map(c => c.column),
      columns: out,
    },
  };
}

// What max_cost_usd is checked against (lib/cost-ceiling.ts), and the ceiling kept in the record
// (setup-ceiling.ts: each AI, enrichment and waterfall column starts with what is left of it).
export function columnCeilingFigures(e: ColumnRunEstimate): CeilingFigures {
  return {
    highUsd: e.high_usd, unpriced: e.unpriced, rowMostUsd: e.row_most_usd,
    rowMostSteps: e.columns.filter(c => c.high_usd !== null && (c.row_most_usd ?? 0) > 0).length,
  };
}

export function columnCeilingOf(e: ColumnRunEstimate, c: { maxCostUsd: number; allowUnpriced: boolean })
  : SetupCeiling {
  return {
    maxCostUsd: c.maxCostUsd, allowUnpriced: c.allowUnpriced,
    highUsd: e.columns.map(x => (x.sends_requests ? 0 : x.high_usd)),
    rowMostUsd: e.columns.map(x => (x.sends_requests || x.high_usd === null ? 0 : x.row_most_usd ?? 0)),
  };
}
