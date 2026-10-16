import type { Request, Response, NextFunction } from 'express';
import { db } from './db';
import { HEAVY_JOB_RETRY_MAX_MS, HEAVY_JOB_RETRY_MS } from './constants';

// One heavy operation per sheet at a time: sort, CSV import, column rename or
// delete, and starting a run (its placeholders go into every target row). They work in slices
// between requests (lib/slices.ts), so the server keeps answering while a
// million rows move. While one runs, other changes to that sheet are refused
// with a clear "busy" message instead of racing it, and appended rows (webhook
// deliveries, new rows) land above whatever range the operation has reserved.
interface BusyEntry {
  what: string; appendFloor: number;
  then?: () => Promise<void>;   // continueInBackground
  finish?: () => Promise<void>; // stayBusyToFinish
}
const busy = new Map<string, BusyEntry>();
// A long read that walks the sheet in pages between requests (a CSV export,
// a duplicate check) holds the sheet against heavy operations, which move or
// rewrite rows under its cursor. Any number can read at once; cell edits and
// appends go on. `what` names the latest reader in a busy message.
const readers = new Map<string, { n: number; what: string }>();
// Bumped each time a heavy operation starts on a sheet, so a background reader
// (lib/column-repair.ts) can tell whether one overlapped its scan.
const epochs = new Map<string, number>();

export function busyEpoch(sheetId: string): number {
  return epochs.get(sheetId) ?? 0;
}

// What the sheet is busy doing ("sorting", "importing"…), or null.
export function sheetBusyWith(sheetId: string): string | null {
  return busy.get(sheetId)?.what ?? null;
}

const BUSY_PREFIX = 'This sheet is busy ';
export function busyMessage(what: string): string {
  return `${BUSY_PREFIX}${what}. Try again when that finishes.`;
}
// A refusal that only means "not now": the sheet was busy (setups retry it).
export const isBusyMessage = (message: string): boolean => message.startsWith(BUSY_PREFIX);

// Whether a heavy operation would be refused right now: one is running, or a
// long read (an export, a duplicate check) holds the sheet.
export const sheetHeld = (sheetId: string): boolean => busy.has(sheetId) || readers.has(sheetId);

// Runs `work` as the sheet's one heavy operation, or returns { busy } at once
// when another is already running or an export is reading the sheet.
// `reserve(n)` keeps appends at or above n.
export async function withSheetBusy<T>(
  sheetId: string,
  what: string,
  work: (reserve: (floor: number) => void) => Promise<T>,
): Promise<T | { busy: string }> {
  const current = busy.get(sheetId);
  if (current) return { busy: busyMessage(current.what) };
  const reading = readers.get(sheetId);
  if (reading) return { busy: busyMessage(reading.what) };
  const entry: BusyEntry = { what, appendFloor: 0 };
  busy.set(sheetId, entry);
  epochs.set(sheetId, busyEpoch(sheetId) + 1);
  try {
    return await work(floor => { entry.appendFloor = floor; });
  } finally {
    void settle(sheetId, entry);
  }
}

// Runs what `work` left for after it returned, then releases the sheet (or
// keeps retrying a failed job). With nothing left, it releases synchronously.
async function settle(sheetId: string, entry: BusyEntry): Promise<void> {
  while (entry.then) {
    const next = entry.then;
    entry.then = undefined;
    try { await next(); }
    catch (err) { console.error(`Sheet ${sheetId}: ${entry.what} failed:`, err); }
  }
  if (entry.finish) await keepFinishing(sheetId, entry, entry.finish);
  else if (busy.get(sheetId) === entry) busy.delete(sheetId);
}

// For a long operation that answers its caller early (a run start returns as
// soon as the run exists; its placeholders go in afterwards), called inside its
// `work`: `task` runs once `work` returns, with the sheet still busy as `what`.
// Its errors are its own to record; they are only logged here.
export function continueInBackground(sheetId: string, what: string, task: () => Promise<void>): void {
  const entry = busy.get(sheetId);
  if (!entry) return;
  entry.what = what;
  entry.then = task;
}

// For a journaled job that failed half-way, called inside its `work`: the rows
// are in an in-between state, so the sheet must not be released. It stays busy,
// with its reserved range, after `work` returns, and `finish` is retried in the
// background (backing off) until it succeeds.
export function stayBusyToFinish(sheetId: string, what: string, finish: () => Promise<void>): void {
  const entry = busy.get(sheetId);
  if (!entry) return;
  entry.what = what;
  entry.finish = finish;
}

async function keepFinishing(sheetId: string, entry: BusyEntry, finish: () => Promise<void>): Promise<void> {
  for (let wait = HEAVY_JOB_RETRY_MS; ; wait = Math.min(wait * 2, HEAVY_JOB_RETRY_MAX_MS)) {
    await new Promise(resolve => setTimeout(resolve, wait));
    try { await finish(); break; }
    catch (err) { console.error(`Sheet ${sheetId}: ${entry.what} failed again, retrying:`, err); }
  }
  if (busy.get(sheetId) === entry) busy.delete(sheetId);
}

// At boot: run `work` as the sheet's heavy operation as soon as it is free (a
// sheet holds at most one journaled job, but this never drops one if not).
export async function whenSheetFree(sheetId: string, what: string, work: (reserve: (floor: number) => void) => Promise<void>): Promise<void> {
  for (;;) {
    const outcome = await withSheetBusy(sheetId, what, work);
    if (!outcome || !('busy' in outcome)) return;
    await new Promise(resolve => setTimeout(resolve, HEAVY_JOB_RETRY_MS));
  }
}

export async function withSheetRead<T>(
  sheetId: string, work: () => Promise<T>, what = 'exporting',
): Promise<T | { busy: string }> {
  const current = busy.get(sheetId);
  if (current) return { busy: busyMessage(current.what) };
  readers.set(sheetId, { n: (readers.get(sheetId)?.n ?? 0) + 1, what });
  try {
    return await work();
  } finally {
    const left = (readers.get(sheetId)?.n ?? 1) - 1;
    if (left > 0) readers.set(sheetId, { n: left, what: readers.get(sheetId)!.what }); else readers.delete(sheetId);
  }
}

// Express guard for a router mounted at a sheet id (`router.use('/:id', …)`):
// while the sheet is busy, any change to it gets a 409 with the reason. Reads,
// and the POSTs listed in `allowed` (appending rows lands above the reserved
// range; a row query only reads), go through. An entry can be a pattern for a
// path with an id in it.
export function refuseChangesWhileBusy(allowed: Array<string | RegExp>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const what = sheetBusyWith(req.params.id);
    const listed = allowed.some(a => (typeof a === 'string' ? a === req.path : a.test(req.path)));
    if (!what || (req.method === 'POST' && listed)) return next();
    res.status(409).json({ error: busyMessage(what), busy: true });
  };
}

// Where an appended row goes: one past the last row, and never inside a range
// a running operation has reserved. Call inside the transaction that inserts.
export function nextRowIndex(sheetId: string, userId: string): number {
  const { m } = db.prepare('SELECT MAX(row_index) AS m FROM rows WHERE sheet_id = ? AND user_id = ?')
    .get(sheetId, userId) as { m: number | null };
  return Math.max(m === null ? 0 : m + 1, busy.get(sheetId)?.appendFloor ?? 0);
}
