// Requests held open for an answer, counted per account and server-wide. Three kinds, each with its own count per
// account, so one never takes the other's slots: a sheet tab's change poll (sheets-changes.ts, 6: a browser
// opens about six requests to one host), a run-status wait (services/run-status-wait.ts) and the home's wait for
// its row counts (routes/tables.ts). A run-status wait holds its slot up to 25 s, the whole wait, so it gets 10:
// one client following several runs side by side, or a few clients on one account. A count wait reads nothing
// while it waits (it is told when a count lands), and gets 4: a few tabs of the home. One account holds at most
// 20 of the server's 2,000, and each change poll or run-status wait is one open request reading one row a second.
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

// The home's wait for its row counts: released by calling what it answers, or refused (null) when the account
// holds MAX_COUNT_WAITS_PER_USER already or the server is full.
const MAX_COUNT_WAITS_PER_USER = 4;
const countWaitsByUser = new Map<string, number>();
export function acquireCountWait(userId: string): (() => void) | null {
  const open = countWaitsByUser.get(userId) ?? 0;
  if (globalHolds >= MAX_HOLDS_GLOBAL || open >= MAX_COUNT_WAITS_PER_USER) return null;
  countWaitsByUser.set(userId, open + 1);
  globalHolds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (countWaitsByUser.get(userId) ?? 1) - 1;
    if (left <= 0) countWaitsByUser.delete(userId);
    else countWaitsByUser.set(userId, left);
    if (globalHolds > 0) globalHolds--;
  };
}
