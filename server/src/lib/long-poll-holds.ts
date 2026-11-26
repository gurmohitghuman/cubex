// Requests held open for an answer, counted per account and server-wide. Four kinds, each with its own count per
// account, so one never takes another's slots: a sheet tab's change poll (sheets-changes.ts, 6: a browser
// opens about six requests to one host), a run-status wait (services/run-status-wait.ts), and the home's waits for
// its row counts and for its runs (routes/tables.ts). A run-status wait holds its slot up to 25 s, the whole wait,
// so it gets 10: one client following several runs side by side, or a few clients on one account. A count wait
// reads nothing while it waits (it is told when a count lands), and gets 4: a few tabs of the home; so does a runs
// wait, which reads the runs going now from their status indexes once a second. One account holds at most 24 of
// the server's 2,000, and each change poll or run-status wait is one open request reading one row a second.
const MAX_HOLDS_PER_USER = 6;
export const MAX_RUN_WAITS_PER_USER = 10;
const MAX_HOLDS_GLOBAL = 2000;
// When the server-wide count is full, nothing says which hold ends first.
const RETRY_WHEN_SERVER_FULL_SEC = 5;

const holdsByUser = new Map<string, number>();
// Each account's open run-status waits: when each one's time is up (ms).
const runWaitsByUser = new Map<string, number[]>();
let globalHolds = 0;

export function acquireLongPollHold(userId: string): boolean {
  const userHolds = holdsByUser.get(userId) ?? 0;
  if (globalHolds >= MAX_HOLDS_GLOBAL || userHolds >= MAX_HOLDS_PER_USER) return false;
  holdsByUser.set(userId, userHolds + 1);
  globalHolds++;
  return true;
}

export function releaseLongPollHold(userId: string): void {
  const userHolds = holdsByUser.get(userId) ?? 0;
  if (userHolds <= 1) holdsByUser.delete(userId);
  else holdsByUser.set(userId, userHolds - 1);
  if (globalHolds > 0) globalHolds--;
}

export type RunWaitSlot = { release: () => void } | { retryAfterSec: number };

// A run-status wait's slot for up to `seconds`, or how long until one is likely free: when the account's
// soonest wait is up (it can end sooner, on a status change).
export function acquireRunWait(userId: string, seconds: number): RunWaitSlot {
  const open = runWaitsByUser.get(userId) ?? [];
  if (open.length >= MAX_RUN_WAITS_PER_USER) {
    return { retryAfterSec: Math.max(1, Math.ceil((Math.min(...open) - Date.now()) / 1000)) };
  }
  if (globalHolds >= MAX_HOLDS_GLOBAL) return { retryAfterSec: RETRY_WHEN_SERVER_FULL_SEC };
  const until = Date.now() + seconds * 1000;
  open.push(until);
  runWaitsByUser.set(userId, open);
  globalHolds++;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      open.splice(open.indexOf(until), 1);
      if (open.length === 0) runWaitsByUser.delete(userId);
      if (globalHolds > 0) globalHolds--;
    },
  };
}

// A kind of hold the home makes, with its own count per account: released by calling what it answers, or refused
// (null) when the account holds `max` of it already or the server is full.
function homeWaits(max: number) {
  const byUser = new Map<string, number>();
  const acquire = (userId: string): (() => void) | null => {
    const open = byUser.get(userId) ?? 0;
    if (globalHolds >= MAX_HOLDS_GLOBAL || open >= max) return null;
    byUser.set(userId, open + 1);
    globalHolds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (byUser.get(userId) ?? 1) - 1;
      if (left <= 0) byUser.delete(userId);
      else byUser.set(userId, left);
      if (globalHolds > 0) globalHolds--;
    };
  };
  return { acquire, openOf: (userId: string): number => byUser.get(userId) ?? 0 };
}

// The home's wait for its row counts (routes/tables.ts GET /row-counts).
export const MAX_COUNT_WAITS_PER_USER = 4;
const countWaits = homeWaits(MAX_COUNT_WAITS_PER_USER);
export const acquireCountWait = countWaits.acquire;
// Tests only: the account's open count waits.
export const countWaitsOf = countWaits.openOf;

// The home's wait for its runs (GET /runs), one per home tab while it is open: as many as the count waits.
export const MAX_RUNS_WAITS_PER_USER = 4;
const runsWaits = homeWaits(MAX_RUNS_WAITS_PER_USER);
export const acquireRunsWait = runsWaits.acquire;
// Tests only: the account's open runs waits.
export const runsWaitsOf = runsWaits.openOf;
