const MAX_HOLDS_PER_USER = 6;
const MAX_HOLDS_GLOBAL = 2000;

const holdsByUser = new Map<string, number>();
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
