// A running row waits for the columns it reads. Another run can start on a column a run already going reads (a
// rerun of it, auto-run's batch, a stopped run putting its ⏳ cells back): the rows the reading run hasn't
// reached would send "⏳ Processing..." to an API or a model that bills for it, or read it as empty. So before
// a row of an HTTP API, enrichment, waterfall or AI run sends anything, it looks whether a column it reads
// (lib/run-inputs/columns.ts, its own columns left out) is held by another run, going or clearing
// (lib/run-locked-columns.ts), and while one is, it waits, keeping its slot: every row of a run reads the same
// columns, so a row given the slot would only wait too, and the rows out stay at the run's concurrency (an
// enrichment's spend hold for the row stays with it as well). It looks again every RUN_INPUT_WAIT_POLL_MS,
// one look a run shared by its rows. Once nothing it reads is held it reads the row again (and its stamp,
// lib/run-inputs/stamp.ts) and goes with what the row holds then. So does every later row of a run that met a
// hold (its page may have been read before the hold, and the other run has written since), and a row whose
// cells in memory hold a ⏳ (they may be older than the look).
//
// The wait needs no record of its own: the row stays ⏳ in its run's column, so a restart, a pause or a stop
// leaves it for its run, as any row not reached yet. A pause or stop during the wait ends it at the next look
// (or at once, through the run's abort signal), the row unwritten. Runs that would wait for each other in a
// ring (lib/run-wait-ring.ts) never could: each row that would wait in one fails instead, naming the columns,
// so the runs end and can be run again one at a time.
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
import { ringWords, runKey, waitRing, type RunKind } from '../lib/run-wait-ring';
import type { RowStamp, RunInputStamper } from '../lib/run-inputs/stamp';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import type { HTTPRunRow } from './http-runner-status';
import type { AIRunRow } from './ai-runner-status';

// A row as a run's loop holds it (lib/run-rows.ts RunRow; rowId is always there for rows read from the sheet).
export interface GateRow { rowIndex: number; rowId?: string | null; data: Record<string, string>; stamp?: RowStamp }
// go: the row to send (read again when it waited); stopped: the run stopped, or the row is gone; ring: the
// words the row fails with.
export type GateAnswer<R extends GateRow> = { go: R } | { stopped: true } | { ring: string };
export interface InputGate { ready<R extends GateRow>(row: R, signal?: AbortSignal): Promise<GateAnswer<R>> }

interface GateOpts {
  kind: RunKind; runId: string; sheetId: string; userId: string;
  reads: Array<string | null>; holds: Set<string>; stamper: RunInputStamper | null; stopped: () => boolean;
}

const holdsPlaceholder = (v: unknown): boolean =>
  typeof v === 'string' && trimBlank(v).startsWith(RUNNING_MARK);

export function inputGate(o: GateOpts): InputGate {
  // Its own columns never hold it up (an AI run holds its "(Data)" column even when it writes none).
  const reads = o.reads.filter((c): c is string => c !== null && !o.holds.has(c));
  const key = runKey(o.kind, o.runId);
  // The last look that found a column held, kept for a poll: the rows waiting share it. met: one ever did.
  let held: { at: number; ring: string | null } | null = null;
  let met = false;
  const look = (): { ring: string | null } | null => {
    if (held && Date.now() - held.at < RUN_INPUT_WAIT_POLL_MS) return held;
    held = null;
    const now = runHeldColumns(o.sheetId, o.userId, { clearing: true });
    if (!reads.some(c => now.has(c))) return null;
    const ring = waitRing(o.sheetId, o.userId, key);
    held = { at: Date.now(), ring: ring ? ringWords(ring) : null };
    met = true;
    return held;
  };
  const byId = db.prepare('SELECT row_index, id, data FROM rows WHERE id = ? AND sheet_id = ? AND user_id = ?');
  const byIndex = db.prepare(
    'SELECT row_index, id, data FROM rows WHERE row_index = ? AND sheet_id = ? AND user_id = ?');
  const readAgain = <R extends GateRow>(row: R): R | null => {
    const r = (row.rowId ? byId.get(row.rowId, o.sheetId, o.userId) : byIndex.get(row.rowIndex, o.sheetId, o.userId)) as
      { row_index: number; id: string; data: string } | undefined;
    if (!r) return null;
    const fresh = { ...row, rowIndex: r.row_index, rowId: r.id, data: parseRowData(r.data) };
    return (o.stamper ? { ...fresh, stamp: o.stamper.stamp(r.data) } : fresh) as R;
  };
  return {
    async ready<R extends GateRow>(row: R, signal?: AbortSignal): Promise<GateAnswer<R>> {
      if (reads.length === 0) return { go: row };
      let current = row;
      let stale = met || reads.some(c => holdsPlaceholder(cellOf(row.data, c)));
      for (;;) {
        const h = look();
        if (h) {
          if (h.ring) return { ring: h.ring };
          if (!await waitUnlessStopped(RUN_INPUT_WAIT_POLL_MS, o.stopped, signal)) return { stopped: true };
          stale = true;
          continue;
        }
        if (!stale) return { go: current };
        // Read again, then looked at once more before it goes: a run may have taken a column meanwhile.
        const fresh = readAgain(current);
        if (!fresh) return { stopped: true };
        current = fresh;
        stale = false;
      }
    },
  };
}

// An HTTP API, enrichment or waterfall run's gate (http_runs): what its request or inputs read.
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
