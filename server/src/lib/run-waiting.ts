// What a run's rows wait for, kept in the run's waiting_on (migration 057) so the app, /api/v1 and MCP can say
// it from the database (services/run-waiting-status.ts). Two waits write it, from the run's own job:
//   - the input gate (services/run-input-gate.ts): a column the run reads is held by another run, so every row
//     the run hasn't started waits, in place or parked;
//   - a waterfall's lookup step (services/waterfall-step-lookup.ts): the cell it would return, on another
//     sheet, holds the ⏳ of a run still filling it there, so that row waits; `rows` counts the rows waiting so.
// The gate's wait wins while there is one (no row goes past it to a lookup step then). A write happens when what
// the run waits for changes (another column, holder, hold, parked or not), never on a look that finds the same,
// and a new count of rows in lookup steps at most every RUN_WAITING_ROWS_WRITE_MS. One UPDATE of the run's own
// row, only while its job's generation is the run's: a job a pause, cancel or resume moved on writes nothing.
// What a run that ended, paused or was stopped meanwhile still holds is never shown (readers check the status),
// and its next look writes it again or clears it.
import { db } from './db';
import { RUN_WAITING_ROWS_WRITE_MS } from './constants';
import { redactError } from './redact';
import type { RunHold } from './run-locked-columns';

export type WaitKind = 'ai' | 'http';
export interface Wait {
  column: string;
  sheet_id?: string;                     // only when the column is on another sheet
  holder: { type: WaitKind; id: string };
  hold: RunHold;
  parked?: true;                         // the run gave its job slot back meanwhile (lib/run-park.ts)
}
export interface WaitingOn extends Wait {
  rows?: number;                         // only for rows waiting inside a waterfall's lookup step
  since: string;                         // when it began waiting for this column and holder (a park keeps it), ISO
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// The stored JSON, or null when there is none or it doesn't read as one.
export function parseWaitingOn(raw: unknown): WaitingOn | null {
  if (!str(raw)) return null;
  let w: Record<string, unknown>;
  try { w = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const h = w?.holder as Record<string, unknown> | undefined;
  if (!w || !str(w.column) || !str(w.since) || !h || !str(h.id) || (h.type !== 'ai' && h.type !== 'http')
    || (w.hold !== 'going' && w.hold !== 'clearing')) return null;
  return {
    column: w.column, holder: { type: h.type, id: h.id }, hold: w.hold, since: w.since,
    ...(str(w.sheet_id) ? { sheet_id: w.sheet_id } : {}),
    ...(w.parked === true ? { parked: true as const } : {}),
    ...(typeof w.rows === 'number' && Number.isInteger(w.rows) && w.rows > 0 ? { rows: w.rows } : {}),
  };
}

const sameWait = (a: Wait | null, b: Wait | null): boolean => a === b || (!!a && !!b
  && a.column === b.column && a.sheet_id === b.sheet_id && a.holder.type === b.holder.type
  && a.holder.id === b.holder.id && a.hold === b.hold && !!a.parked === !!b.parked);
const waitKey = (w: Wait): string => JSON.stringify([w.column, w.sheet_id ?? '', w.holder.type, w.holder.id, w.hold]);

// One run's waits, as its job sees them; writes waiting_on as above. writes: how many it made (tests read it).
export class RunWaiting {
  private gate: Wait | null = null;
  private readonly steps = new Map<string, { wait: Wait; rows: number }>();
  private written: WaitingOn | null;
  private lastWrite = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  writes = 0;

  // stored: what the run row held when the job read it (a wait from before a restart or a park keeps its since).
  constructor(private readonly kind: WaitKind, private readonly runId: string, private readonly generation: number,
    stored: unknown) {
    this.written = parseWaitingOn(stored);
  }

  // The input gate's wait, or null once nothing the run reads is held (or its rows fail in a ring).
  gateWait(w: Wait | null): void {
    this.gate = w;
    // Against what is stored, not the last look: a job's first look clears a wait from before it, or keeps it.
    this.flush();
  }

  // A row waits inside a lookup step for this, until the returned function is called.
  stepWait(w: Wait): () => void {
    const key = waitKey(w);
    const at = this.steps.get(key) ?? { wait: w, rows: 0 };
    at.rows++;
    this.steps.set(key, at);
    this.flush();
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--at.rows <= 0) this.steps.delete(key);
      this.flush();
    };
  }

  // Clears a pending count write (the run's loop ended).
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private current(): (Wait & { rows?: number }) | null {
    if (this.gate) return this.gate;
    let top: { wait: Wait; rows: number } | null = null;
    for (const s of this.steps.values()) if (!top || s.rows > top.rows) top = s;
    return top && { ...top.wait, rows: top.rows };
  }

  private flush(): void {
    const now = this.current();
    if (sameWait(this.written, now)) {
      if (!now || now.rows === this.written?.rows) return;
      // Only the count moved: at most one write per interval, the latest count.
      const later = this.lastWrite + RUN_WAITING_ROWS_WRITE_MS - Date.now();
      if (later > 0) {
        this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, later);
        this.timer.unref?.();
        return;
      }
      const { rows, ...wait } = now;
      this.write({ ...wait, ...(rows ? { rows } : {}), since: this.written!.since });
      return;
    }
    // The same column and holder, now parked or back in place: the same wait, its since kept.
    const was = this.written;
    const since = now && was && waitKey(now) === waitKey(was) ? was.since : new Date().toISOString();
    this.write(now && { ...now, since });
  }

  private write(w: WaitingOn | null): void {
    this.close();
    const table = this.kind === 'ai' ? 'ai_runs' : 'http_runs';
    // What it waits for is only said, never acted on: a write that fails is logged, and the run goes on.
    try {
      db.prepare(`UPDATE ${table} SET waiting_on = ? WHERE id = ? AND worker_generation = ?`)
        .run(w ? JSON.stringify(w) : null, this.runId, this.generation);
    } catch (error) {
      console.warn(`Run ${this.kind}:${this.runId} couldn't save what it waits for:`, redactError(error));
    }
    this.written = w;
    this.lastWrite = Date.now();
    this.writes++;
  }
}
