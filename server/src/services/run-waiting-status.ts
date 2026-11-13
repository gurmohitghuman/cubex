// What a run's rows wait for, said from the database for the app (GET /api/ai/runs, /api/http/runs), /api/v1's run
// summaries and MCP's get_run_status and list_runs: the run's own waiting_on (lib/run-waiting.ts), the run that
// holds the column, read by its id, and the run's own counters. No row is read. Only a run that is running or
// pending says it: one that ended, paused or was stopped waits for nothing.
import { db } from '../lib/db';
import { parseWaitingOn, type WaitingOn } from '../lib/run-waiting';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { isWaterfallConfig } from '../lib/waterfall/config';

export type WaitingRunType = 'ai' | 'http' | 'enrichment' | 'waterfall';
export interface RunWaitingView {
  column: string;                          // the column its rows wait for
  // Only when that column is on another sheet (a waterfall's lookup step): that sheet, its name and its table.
  sheet_id?: string;
  sheet_name?: string;
  table_id?: string;
  held_by: { run_type: WaitingRunType; run_id: string; column_name: string | null; status: string };
  // Rows of this run that wait: the rows it hasn't finished (for a moment also rows already out, which finish
  // first), or, for rows waiting inside a waterfall's lookup step, those rows.
  rows_waiting: number;
  parked: boolean;                         // it gave its job slot back meanwhile, and is pending until it goes on
  since: string;                           // when it began waiting for this
  message: string;
}

type Holder = { status: string; column_name: string | null; config?: string | null; placeholder_work: string | null };
type Sheet = { name: string; table_id: string };

function holderOf(w: WaitingOn, userId: string): Holder | undefined {
  return w.holder.type === 'ai'
    ? db.prepare('SELECT status, column_name, placeholder_work FROM ai_runs WHERE id = ? AND user_id = ?')
      .get(w.holder.id, userId) as Holder | undefined
    : db.prepare(`SELECT status, master_column_name AS column_name, config, placeholder_work FROM http_runs
      WHERE id = ? AND user_id = ?`).get(w.holder.id, userId) as Holder | undefined;
}

function runTypeOf(w: WaitingOn, h: Holder | undefined): WaitingRunType {
  if (w.holder.type === 'ai') return 'ai';
  try {
    const config = JSON.parse(h?.config ?? 'null');
    if (isWaterfallConfig(config)) return 'waterfall';
    if (isEnrichmentConfig(config)) return 'enrichment';
  } catch { /* not JSON: a plain HTTP run */ }
  return 'http';
}

const rowsText = (n: number): string => (n === 1 ? '1 row waits' : `${n} rows wait`);

// The words: which column, where, what its run is doing, how many rows wait.
export function waitingWords(o: {
  column: string; sheetName?: string; holderStatus: string | null; clearing: boolean; rows: number; parked: boolean;
}): string {
  const col = o.sheetName ? `"${o.column}" on sheet "${o.sheetName}"` : `"${o.column}"`;
  const filler = o.sheetName ? 'a run there' : 'another run';
  const rows = rowsText(o.rows);
  const said = o.clearing ? `Waits for ${col} to get back what it held before a stopped run: ${rows}.`
    : o.holderStatus === 'running' ? `Waits for ${col}, which ${filler} is still filling: ${rows}.`
      : o.holderStatus === 'paused' ? `Waits for ${col}, whose run is paused: resume or stop that run. ${rows}.`
        : o.holderStatus === 'pending' ? `Waits for ${col}, whose run is queued: ${rows}.`
          : `Waits for ${col}, whose run just ended: its rows go on in a moment.`;
  return o.parked ? `${said} It gave its job slot back meanwhile.` : said;
}

export function runWaiting(run: {
  status: string; waiting_on?: string | null; total_rows?: number | null; processed_rows?: number | null;
  user_id: string;
}): RunWaitingView | undefined {
  if (run.status !== 'running' && run.status !== 'pending') return undefined;
  const w = parseWaitingOn(run.waiting_on);
  if (!w) return undefined;
  const h = holderOf(w, run.user_id);
  const sheet = w.sheet_id ? db.prepare('SELECT name, table_id FROM sheets WHERE id = ? AND user_id = ?')
    .get(w.sheet_id, run.user_id) as Sheet | undefined : undefined;
  const rows = w.rows ?? Math.max(0, (run.total_rows ?? 0) - (run.processed_rows ?? 0));
  const going = !!h && ['pending', 'running', 'paused'].includes(h.status);
  const clearing = !!h && !going && h.placeholder_work === 'clearing';
  // A run claimed again after it parked says it once its gate looks again; until then it isn't parked.
  const parked = !!w.parked && run.status === 'pending';
  return {
    column: w.column,
    ...(w.sheet_id ? { sheet_id: w.sheet_id } : {}),
    ...(sheet ? { sheet_name: sheet.name, table_id: sheet.table_id } : {}),
    held_by: {
      run_type: runTypeOf(w, h), run_id: w.holder.id, column_name: h?.column_name ?? null, status: h?.status ?? 'gone',
    },
    rows_waiting: rows, parked, since: w.since,
    message: waitingWords({
      column: w.column, sheetName: sheet?.name, holderStatus: going ? h!.status : null, clearing, rows, parked,
    }),
  };
}

// The part a summary or an app's run gets: { waiting } while it waits, nothing otherwise.
export function waitingPart(run: Parameters<typeof runWaiting>[0]): { waiting?: RunWaitingView } {
  const waiting = runWaiting(run);
  return waiting ? { waiting } : {};
}

// The app's run lists (GET /api/ai/runs, /api/http/runs): each run that waits carries `waiting`.
type WaitingRow = Parameters<typeof runWaiting>[0];
export const withWaiting = <T extends WaitingRow>(runs: T[]): Array<T & { waiting?: RunWaitingView }> =>
  runs.map(r => ({ ...r, ...waitingPart(r) }));
