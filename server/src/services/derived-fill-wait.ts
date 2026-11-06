// Derived fills (derived-fill.ts) waiting for their pass to go on, with their
// sheet free meanwhile: what each waits for (the column's view says so), and
// taking the sheet again once it can go on. One waiter per fill: a wait set
// while one is pending replaces it. A waiter looks every pollMs; a wait that
// names the sheet whose fill it waits for (wakeOn: a lookup reading a column
// being filled there) also looks at once when a fill there ends, so it goes on
// right after, and the poll only catches what ends a fill otherwise (that
// column deleted, its sheet in the trash).
import { LOOKUP_WAIT_POLL_MS } from '../lib/constants';
import type { DerivedWait } from './derived-kind';
import { IN_TRASH_NOTE, isParked } from './derived-fill-parked';

interface Waiter {
  wait: DerivedWait;
  filling: () => boolean;   // its record still filling (else the waiter goes, and nothing resumes)
  goOn: () => void;         // takes the sheet and goes on with the fill
  label: string;            // in logs
  timer: ReturnType<typeof setTimeout> | null;
}
const waiters = new Map<string, Waiter>();

export const derivedFillWait = (id: string): string | null =>
  waiters.get(id)?.wait.note ?? (isParked(id) ? IN_TRASH_NOTE : null);

function look(id: string, w: Waiter): void {
  w.timer = null;
  if (waiters.get(id) !== w) return;
  let go: boolean;
  try {
    if (!w.filling()) { waiters.delete(id); return; }
    go = w.wait.ready();
  } catch (err) {
    console.error(`Checking whether ${w.label} can go on failed:`, err);
    go = false;
  }
  if (!go) { lookIn(id, w, w.wait.pollMs ?? LOOKUP_WAIT_POLL_MS); return; }
  waiters.delete(id);
  w.goOn();
}

function lookIn(id: string, w: Waiter, ms: number): void {
  if (w.timer) clearTimeout(w.timer);
  w.timer = setTimeout(() => look(id, w), ms);
  w.timer.unref?.();
}

export function waitThenGoOn(id: string, w: Omit<Waiter, 'timer'>): void {
  const had = waiters.get(id);
  const waiter: Waiter = { ...w, timer: had?.timer ?? null };
  waiters.set(id, waiter);
  lookIn(id, waiter, w.wait.pollMs ?? LOOKUP_WAIT_POLL_MS);
}

// A fill on this sheet ended (after the transaction that ended it): the fills
// waiting for one there look now.
export function wakeFillsWaitingOn(sheetId: string): void {
  for (const [id, w] of waiters) if (w.wait.wakeOn === sheetId) lookIn(id, w, 0);
}

// Fills of each column that ended in this process (sheet, column), done or
// failed: a lookup reading that column tells from them whether one started
// and ended while it wasn't looking (lookup-fill-changes.ts).
const ended = new Map<string, number>();
const endKey = (sheetId: string, column: string) => `${sheetId}\u0000${column}`;
export const fillsEnded = (sheetId: string, column: string): number => ended.get(endKey(sheetId, column)) ?? 0;

// A fill of this column ended: counted, and the fills waiting for one on its sheet look now.
export function fillEnded(sheetId: string, column: string): void {
  ended.set(endKey(sheetId, column), fillsEnded(sheetId, column) + 1);
  wakeFillsWaitingOn(sheetId);
}
