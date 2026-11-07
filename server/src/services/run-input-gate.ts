// A row of a run waits for the columns it reads. Another run can start on a column a run already going reads (a
// rerun of it, auto-run's batch, a stopped run putting its ⏳ cells back): the rows the reading run hasn't
// reached would send "⏳ Processing..." to an API or a model that bills for it, or read it as empty. So before
// a row of an HTTP API, enrichment, waterfall or AI run starts (services/run-gated-rows.ts), before its spend is
// sized or held, the gate looks whether a column it reads (lib/run-inputs/columns.ts, its own columns left out)
// is held by another run, going or clearing (lib/run-locked-columns.ts). While one is, what it does depends on
// what it waits for (lib/run-wait-ring.ts):
//   - every run down the chain is running: it waits in place, looking again every RUN_INPUT_WAIT_POLL_MS (one
//     look a run shared by its rows), the run's loop blocked there and beating;
//   - the chain reaches a run that can't go on in a job slot (queued, paused, or parked itself): the run parks,
//     giving its slot back (lib/run-park.ts), the row left ⏳;
//   - the runs wait for each other in a ring and this one is the newest that isn't paused: the row fails, its
//     words naming the columns, so the others finish (logged once a run).
// Once nothing it reads is held, it reads the row again (and its stamp, lib/run-inputs/stamp.ts) and goes with
// what the row holds then. So does every later row of a run that met a hold (its page may have been read before
// the hold, and the other run has written since), and a row whose cells in memory hold a ⏳. A row deleted
// meanwhile is gone: nothing is sent for it. A stop of the run (paused, cancelled, superseded, or its own end: a
// brake, a cap, a database that can't be written) ends the wait at once, the row unsent and ⏳ for the resume.
import { db } from '../lib/db';
import { RUN_INPUT_WAIT_POLL_MS } from '../lib/constants';
import { getSheetColumns } from '../lib/sql-helpers';
import { parseRowData } from '../lib/sql-rows';
import { cellOf } from '../lib/row-cell';
import { RUNNING_MARK, trimBlank } from '../lib/run-markers';
import { waitUnlessStopped } from '../lib/http-retry';
import { addAiRunColumns, addHttpRunColumns, runHeldColumns } from '../lib/run-locked-columns';
import { aiRunInputColumns, requestRunInputColumns } from '../lib/run-inputs/columns';
import { aiRunStamper, requestRunStamper } from '../lib/run-inputs/stampers';
import { runKey, waitPlan, type RunKind } from '../lib/run-wait-ring';
import { parkDelay } from '../lib/run-park';
import type { RowStamp, RunInputStamper } from '../lib/run-inputs/stamp';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import type { HTTPRunRow } from './http-runner-status';
import type { AIRunRow } from './ai-runner-status';

// A row as a run's loop holds it (lib/run-rows.ts RunRow; rowId is always there for rows read from the sheet).
export interface GateRow { rowIndex: number; rowId?: string | null; data: Record<string, string>; stamp?: RowStamp }
// go: the row to send (read again when it must be); held: it must wait (check only); ring: the words it fails
// with; park: the run parks, picked up again after this many ms; gone: deleted; stopped: the run stopped.
export type GateCheck<R> = { go: R } | { held: true } | { ring: string } | { park: number } | { gone: true };
export type GateReady<R> = Exclude<GateCheck<R>, { held: true }> | { stopped: true };
export interface InputGate {
  check<R extends GateRow>(row: R): GateCheck<R>;
  ready<R extends GateRow>(row: R, opts?: { signal?: AbortSignal; tick?: () => void }): Promise<GateReady<R>>;
  // Set once a row was told to park: the run starts no more rows, and parks once the ones out have settled.
  readonly parked: number | null;
}

interface GateOpts {
  kind: RunKind; runId: string; sheetId: string; userId: string;
  reads: Array<string | null>; holds: Set<string>; stamper: RunInputStamper | null; stopped: () => boolean;
}
type Look = { ring: string } | { park: number } | { wait: true };

const holdsPlaceholder = (v: unknown): boolean => typeof v === 'string' && trimBlank(v).startsWith(RUNNING_MARK);

export function inputGate(o: GateOpts): InputGate {
  // Its own columns never hold it up (an AI run holds its "(Data)" column even when it writes none).
  const reads = o.reads.filter((c): c is string => c !== null && !o.holds.has(c));
  const key = runKey(o.kind, o.runId);
  // The last look that found a column held, kept for a poll: the rows share it. met: one ever did.
  let held: { at: number; look: Look } | null = null;
  let met = false, ringLogged = false;
  let parked: number | null = null;
  const look = (): Look | null => {
    if (held && Date.now() - held.at < RUN_INPUT_WAIT_POLL_MS) return held.look;
    held = null;
    const now = runHeldColumns(o.sheetId, o.userId, { clearing: true });
    if (!reads.some(c => now.has(c))) return null;
    met = true;
    const plan = waitPlan(o.sheetId, o.userId, key);
    const l: Look = plan === null ? { wait: true } : 'ring' in plan ? plan : { park: parkDelay(plan.park) };
    if ('park' in l) parked ??= l.park;
    if ('ring' in l && !ringLogged) {
      ringLogged = true;
      console.warn(`Run ${key} fails the rows that would wait: ${l.ring}`);
    }
    held = { at: Date.now(), look: l };
    return l;
  };
  const byId = db.prepare('SELECT row_index, id, data FROM rows WHERE id = ? AND sheet_id = ? AND user_id = ?');
  const byIndex = db.prepare(
    'SELECT row_index, id, data FROM rows WHERE row_index = ? AND sheet_id = ? AND user_id = ?');
  const readAgain = <R extends GateRow>(row: R): R | null => {
    const r = (row.rowId ? byId.get(row.rowId, o.sheetId, o.userId)
      : byIndex.get(row.rowIndex, o.sheetId, o.userId)) as { row_index: number; id: string; data: string } | undefined;
    if (!r) return null;
    const fresh = { ...row, rowIndex: r.row_index, rowId: r.id, data: parseRowData(r.data) };
    return (o.stamper ? { ...fresh, stamp: o.stamper.stamp(r.data) } : fresh) as R;
  };
  const check = <R extends GateRow>(row: R): GateCheck<R> => {
    if (reads.length === 0) return { go: row };
    let current = row;
    let stale = met || reads.some(c => holdsPlaceholder(cellOf(row.data, c)));
    for (;;) {
      const l = look();
      if (l) return 'wait' in l ? { held: true } : l;
      if (!stale) return { go: current };
      // Read again, then looked at once more before it goes: a run may have taken a column meanwhile.
      const fresh = readAgain(current);
      if (!fresh) return { gone: true };
      current = fresh;
      stale = false;
    }
  };
  return {
    check,
    async ready(row, opts = {}) {
      for (;;) {
        const c = check(row);
        if (!('held' in c)) return c;
        opts.tick?.();
        if (!await waitUnlessStopped(RUN_INPUT_WAIT_POLL_MS, o.stopped, opts.signal)) return { stopped: true };
      }
    },
    get parked() { return parked; },
  };
}

// An HTTP API, enrichment or waterfall run's gate (http_runs): what its request or inputs read. stopped: the run
// stopped in the database, or its loop ended by itself.
export function requestInputGate(run: HTTPRunRow, config: HTTPAPIConfig, stopped: () => boolean): InputGate {
  const columns = getSheetColumns(run.sheet_id, run.user_id, false);
  const holds = new Set<string>();
  addHttpRunColumns(run, holds);
  return inputGate({
    kind: 'http', runId: run.id, sheetId: run.sheet_id, userId: run.user_id, holds, stopped,
    reads: requestRunInputColumns(config, run.master_column_name ?? '', columns),
    stamper: requestRunStamper(run, config),
  });
}

// An AI run's gate: what its prompt reads.
export function aiInputGate(run: AIRunRow, stopped: () => boolean): InputGate {
  const columns = getSheetColumns(run.sheet_id, run.user_id, false);
  const holds = new Set<string>();
  addAiRunColumns({ ...run, data_column: run.data_column ?? null }, holds);
  return inputGate({
    kind: 'ai', runId: run.id, sheetId: run.sheet_id, userId: run.user_id, holds, stopped,
    reads: aiRunInputColumns(run, columns), stamper: aiRunStamper(run),
  });
}
