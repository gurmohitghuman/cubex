// What firing a run schedule now would cost (a pure read: nothing starts, nothing is spent), for the Scheduled
// reruns drawer's line before Run now, and GET /api/v1/run-schedules/:id/estimate. It walks the firing's sheets as a
// firing does (run-schedule-fire.ts eachFiringSheet: the same columns, rows, and share of a table's max_cost_usd)
// and prices each sheet's column run as run_columns' estimate_only does, as the caller (as fire now runs).
import { currentActor } from '../lib/actor';
import { loadSchedule } from './run-schedule-store';
import { eachFiringSheet } from './run-schedule-fire';
import { runColumns, type ColumnRunOutcome } from './column-run';
import type { RunFail } from './run-shared';

// A column run's estimate, with what a ceiling adds (column-run.ts).
export type SheetFiringEstimate = Extract<ColumnRunOutcome, { ok: { estimate: unknown } }>['ok']['estimate'];

export interface FiringEstimate {
  // Each sheet a firing now would start a column run on, with that run's estimate.
  sheets: Array<{ sheet_id: string; estimate: SheetFiringEstimate }>;
  // Their price, summed (an HTTP API column's requests and a column with no known price are not in it).
  low_usd: number; high_usd: number;
  // What wouldn't start now, and why: over max_cost_usd, a column gone, the sheet in the trash.
  problems: string[];
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

export async function estimateScheduleFiring(userId: string, id: string, caller: { hasSecretsScope: boolean })
  : Promise<{ ok: FiringEstimate } | RunFail> {
  const s = loadSchedule(userId, id);
  if (!s) return { fail: 'not_found', message: 'Schedule not found' };
  const sheets: FiringEstimate['sheets'] = [];
  const problems = await eachFiringSheet(s, currentActor(), caller.hasSecretsScope, async t => {
    const out = await runColumns(userId, t.sheetId, { ...t.run, estimateOnly: true, maxCostUsd: t.max }, caller);
    if ('fail' in out) { t.said(out.message); return false; }
    if (!('estimate' in out.ok)) return false;
    const e = out.ok.estimate;
    if (e.over_ceiling) { t.said(e.ceiling_problem ?? 'It could cost more than max_cost_usd.'); return false; }
    sheets.push({ sheet_id: t.sheetId, estimate: e });
    return true;
  });
  return {
    ok: {
      sheets, problems,
      low_usd: round(sheets.reduce((n, x) => n + x.estimate.low_usd, 0)),
      high_usd: round(sheets.reduce((n, x) => n + x.estimate.high_usd, 0)),
    },
  };
}
