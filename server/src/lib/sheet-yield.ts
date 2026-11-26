// The user-yield window (API process only). A sort, row delete, transfer or
// column rename/delete that an auto-run run blocked answers 409 and asks the
// sheet to yield: no new auto-run starts there for AUTORUN_USER_YIELD_MS, so
// the small run in flight ends and the user's retry goes through. In memory on
// purpose: a restart simply ends the window. Auto-delete on a webhook sheet asks for a shorter one when
// auto-run's runs keep it out (services/webhook-auto-delete-sweep.ts); a longer window already there stays.
import { AUTORUN_USER_YIELD_MS } from './constants';

const until = new Map<string, number>();

export function yieldSheetToUser(sheetId: string, now = Date.now(), ms = AUTORUN_USER_YIELD_MS): void {
  until.set(sheetId, Math.max(until.get(sheetId) ?? 0, now + ms));
}

export function sheetYielding(sheetId: string, now = Date.now()): boolean {
  const end = until.get(sheetId);
  if (end === undefined) return false;
  if (end > now) return true;
  until.delete(sheetId);
  return false;
}
