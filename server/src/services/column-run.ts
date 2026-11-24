// Run chosen columns on chosen rows in one call (app, /api/v1, MCP): each
// column is one of the sheet's run columns (AI, HTTP API, enrichment,
// waterfall), run with its own newest setup on the rows the mode picks, among
// the chosen row ids or the rows a where matches. A column reading another
// chosen column waits for that one's whole run (column-run-plan.ts). It is
// either priced (estimateOnly: a pure read, column-run-estimate.ts) or started
// as a setup run with no setup (setup-run-store.ts), followed and controlled
// as one: get_setup_run, control_setup_run, the run webhook's kind 'setup'.
// With max_cost_usd, a start whose estimate could pass it (or that has a
// column with no price, unless allow_unpriced) is refused and creates
// nothing; each spending column then starts with what is left of it.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { viewWhere } from '../lib/views/filters';
import { activeWhere, type WhereItem } from '../lib/row-filter/where';
import type { SavedFilters } from './row-filter';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { ceilingProblem, ceilingView } from '../lib/cost-ceiling';
import { countOf, logSheetChange } from '../lib/change-log';
import { webhookIdProblem } from './run-hooks-attach';
import { actorSpendRefusal } from './token-spend';
import { planColumnRun } from './column-run-plan';
import { rowIdPlaces, selectedRowsProblem, wherePlaces } from './column-run-rows';
import {
  columnCeilingFigures, columnCeilingOf, estimateColumnRun, type ColumnRunEstimate,
} from './column-run-estimate';
import { getSetupRun, insertSetupRun, type SetupRunView } from './setup-run-store';
import { advanceSetupRun } from './setup-runner';
import type { ColumnRunInput, ColumnRunMode } from './column-run-input';
import type { RunFail } from './run-shared';

type PricedEstimate = ColumnRunEstimate & ReturnType<typeof ceilingView>;
export type ColumnRunOutcome =
  | { ok: { estimate: PricedEstimate } }
  | { ok: { setup_run: SetupRunView } }
  | (RunFail & { estimate?: PricedEstimate });

const ROW_WORDS: Record<ColumnRunMode, string> = {
  empty: 'their empty rows', errored: 'their failed rows', out_of_date: 'their out-of-date rows',
  empty_or_out_of_date: 'their empty or out-of-date rows', all: 'every row',
};
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

function shownFilter(sheetId: string, userId: string): WhereItem[] | null {
  const saved = db.prepare('SELECT empty_filter, column_filters, row_filter FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as SavedFilters | undefined;
  const where = viewWhere(saved);
  return activeWhere(where).length ? where : null;
}

// The record's name, as lists show it: "Run columns: Score, Email" (cut short past a few).
function nameOf(columns: string[]): string {
  const shown = columns.slice(0, 3).join(', ');
  return `Run columns: ${shown}${columns.length > 3 ? ` and ${columns.length - 3} more` : ''}`;
}

export async function runColumns(
  userId: string, sheetId: string, input: ColumnRunInput, caller: { hasSecretsScope: boolean },
): Promise<ColumnRunOutcome> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const hookProblem = webhookIdProblem(userId, input.webhookId);
  if (hookProblem) return bad(hookProblem);
  // The app's "only rows in the current filter": the filter the sheet shows, as the grid reads it, kept as
  // the run's where (a filter changed later doesn't change the run).
  if (input.inFilter) input = { ...input, where: shownFilter(sheetId, userId) };
  const planned = planColumnRun(userId, sheetId, input, caller);
  if ('fail' in planned) return planned;
  const plan = planned.ok;

  let within: number[] | null = null;
  if (input.rowIds) within = rowIdPlaces(sheetId, userId, input.rowIds);
  else if (input.where) {
    const rows = await wherePlaces(sheetId, userId, input.where);
    if ('problem' in rows) return bad(rows.problem);
    if (rows.length === 0) return bad('No rows match the where.');
    const over = selectedRowsProblem(plan.columns.map(c => c.kind), rows.length);
    if (over) return bad(over);
    within = rows;
  }

  const ceiling = { maxCostUsd: input.maxCostUsd, allowUnpriced: input.allowUnpriced };
  let priced: PricedEstimate | null = null;
  if (input.estimateOnly || ceiling.maxCostUsd !== null) {
    const est = await estimateColumnRun(userId, sheetId, plan, input.mode, within);
    if ('fail' in est) return est;
    if (est.ok.rows_in_scope === 0) return bad('This sheet has no rows yet. Import or add rows first.');
    priced = { ...est.ok, ...ceilingView(columnCeilingFigures(est.ok), ceiling) };
  }
  if (input.estimateOnly) return { ok: { estimate: priced! } };
  const over = priced && ceilingProblem(columnCeilingFigures(priced), ceiling);
  if (over) return { fail: 'over_ceiling', message: over, estimate: priced! };
  // Its columns spend for the access token starting it (setup-runner.ts runs them as it).
  const capped = actorSpendRefusal(userId);
  if (capped) return { fail: 'forbidden', message: capped };
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };

  const columns = plan.columns.map(c => c.column);
  const kept = priced && ceiling.maxCostUsd !== null
    ? { ceiling: columnCeilingOf(priced, { maxCostUsd: ceiling.maxCostUsd, allowUnpriced: ceiling.allowUnpriced }) }
    : {};
  const id = insertSetupRun({
    userId, sheetId, setupId: null, setupName: nameOf(columns),
    plan: {
      spec: { v: 1, inputs: [], keys: [], steps: [] }, layers: plan.columns.map(c => c.layer),
      columns: {
        steps: plan.columns.map((c, i) => ({
          column: c.column, kind: c.kind, writes: plan.writes[i], between: c.between,
        })),
        mode: input.mode, where: input.where,
      },
      ...kept,
    },
    targetRowIds: input.rowIds, allowSecrets: caller.hasSecretsScope, autoRun: false, webhookId: input.webhookId,
  });
  const scope = input.rowIds ? ` among ${countOf(input.rowIds.length, 'chosen row')}`
    : input.where ? ' among the rows the filter matches' : '';
  logSheetChange(sheetId, userId, 'run_started',
    `Ran ${countOf(columns.length, 'column')} (${columns.join(', ')}) on ${ROW_WORDS[input.mode]}${scope}`,
    { detail: { setup_run_id: id, columns, mode: input.mode } });
  // The first layer starts now; the sweep carries on if this round can't (logged, not the caller's error).
  try {
    await advanceSetupRun(id);
  } catch (err) {
    console.error(`Column run ${id} couldn't start its first columns yet:`, err);
  }
  return { ok: { setup_run: getSetupRun(userId, id)! } };
}
