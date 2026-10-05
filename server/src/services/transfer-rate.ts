import { TRANSFER_STARTS_PER_MIN } from '../lib/api-v1-constants';

const starts = new Map<string, number[]>();
const active = new Set<string>();

export function acquireTransferSlot(userId: string): 'ok' | 'rate' | 'active' {
  const now = Date.now();
  const recent = (starts.get(userId) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= TRANSFER_STARTS_PER_MIN) return 'rate';
  if (active.has(userId)) return 'active';
  recent.push(now);
  starts.set(userId, recent);
  active.add(userId);
  return 'ok';
}

export function releaseTransferSlot(userId: string): void {
  active.delete(userId);
}
