// Stopping every run on a sheet at once: the app's "Stop all", POST
// /v1/sheets/:id/runs/stop and MCP control_run's cancel_all. It goes through
// the controls that stop one setup or one run (setup-run-control.ts,
// run-lifecycle.ts), setups first so none starts its next step meanwhile. Each
// answers at once; the runs' ⏳ cells clear in the background, and calls
// already sent finish (treg and OpenRouter bill them). Clean, formula and
// stored-answer fills are free and finish. Auto-run settings stay: a column
// whose auto-run batch was stopped pauses, as when that run is stopped by hand
// (autorun-stop.ts), and the answer names the auto-runs still on.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { fillingColumns } from '../lib/field-fill-columns';
import { stopWords } from '../lib/run-stop-words';
import { cancelRun } from './run-lifecycle';
import { controlSetupRun } from './setup-run-control';
import { CAPACITY_PAUSES, RETRY_PAUSES } from './autorun-entry';
import { activeSetupRuns, activeSheetRuns, type SheetRun, type SheetSetupRun } from './sheet-runs';
import type { RunFail } from './run-shared';
import { logSheetChange, withoutChangeLog } from '../lib/change-log';

export interface SheetStopResult {
  stopped_runs: Array<Omit<SheetRun, 'status'>>;
  stopped_setup_runs: Array<Omit<SheetSetupRun, 'status'>>;
  auto_run_paused: string[];
  auto_run_on: string[];
  still_filling: string[];
  message: string;
}

// Pauses that lift on their own (autorun-loop.ts pauseLifted): treg's stops a
// few minutes on, caps at midnight UTC or a raise, a column or key once it is
// back, room in a list's sheet, a broken loop. An auto-run paused like this is
// still on: it starts runs again without anyone resuming it.
const LIFTS_ON_ITS_OWN = JSON.stringify([...RETRY_PAUSES, ...CAPACITY_PAUSES, 'missing_input', 'no_key', 'dest_full',
  'loop']);

// Columns whose auto-run is on, now or once such a pause lifts: new rows start runs there.
const autorunsOn = (sheetId: string, userId: string): string[] => db.prepare(`SELECT status_column
    FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND enabled = 1
      AND (paused_reason IS NULL OR paused_reason IN (SELECT value FROM json_each(?)))
      AND kind IN ('http', 'enrichment', 'waterfall') ORDER BY status_column`)
  .pluck().all(sheetId, userId, LIFTS_ON_ITS_OWN) as string[];

// Of these columns, the ones whose auto-run a person's stop paused (autorunStoppedByUser).
const pausedByStop = (sheetId: string, userId: string, columns: string[]): string[] => db.prepare(`SELECT
    status_column FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND enabled = 1 AND paused_reason = 'user'
      AND status_column IN (SELECT value FROM json_each(?)) ORDER BY status_column`)
  .pluck().all(sheetId, userId, JSON.stringify(columns)) as string[];

const cancelledIds = (ids: string[]): Set<string> => new Set(db.prepare(`SELECT id FROM ai_runs
    WHERE id IN (SELECT value FROM json_each(?)) AND status = 'cancelled'
  UNION ALL SELECT id FROM http_runs WHERE id IN (SELECT value FROM json_each(?)) AND status = 'cancelled'`)
  .pluck().all(JSON.stringify(ids), JSON.stringify(ids)) as string[]);

export async function stopSheetRuns(userId: string, sheetId: string): Promise<{ ok: SheetStopResult } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const runs = activeSheetRuns(sheetId, userId);
  const setups: SheetStopResult['stopped_setup_runs'] = [];
  // One line in the change log for the lot, below.
  await withoutChangeLog(async () => {
    for (const s of activeSetupRuns(sheetId, userId)) {
      // One that ended meanwhile answers a conflict and isn't listed.
      const out = await controlSetupRun(userId, s.setup_run_id, 'cancel', true);
      if ('ok' in out) setups.push({ setup_run_id: s.setup_run_id, setup: s.setup });
    }
    for (const r of runs) await cancelRun(r.run_type === 'ai' ? 'ai' : 'http', r.run_id, userId);
  });
  // Stopped: the ones cancelled now (by this stop, or its setups' stop). A run
  // that finished on its own meanwhile isn't listed.
  const cancelled = cancelledIds(runs.map(r => r.run_id));
  const stopped = runs.filter(r => cancelled.has(r.run_id)).map(({ status: _status, ...r }) => r);
  const paused = pausedByStop(sheetId, userId, stopped.filter(r => r.auto_run).map(r => r.column));
  const autoOn = autorunsOn(sheetId, userId);
  const filling = fillingColumns(sheetId, userId);
  if (stopped.length > 0 || setups.length > 0) {
    logSheetChange(sheetId, userId, 'runs_stopped', `Stopped every run (${stopped.map(r => r.column).concat(
      setups.map(x => `setup ${x.setup}`)).join(', ')})`, { detail: { runs: stopped.length, setups: setups.length } });
  }
  return {
    ok: {
      stopped_runs: stopped, stopped_setup_runs: setups, auto_run_paused: paused, auto_run_on: autoOn,
      still_filling: filling,
      message: stopWords({
        runs: stopped.map(r => r.column), setups: setups.map(s => s.setup), paused, autoOn, filling,
      }),
    },
  };
}
