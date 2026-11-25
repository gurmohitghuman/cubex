// The clock a bulk writer's slice is timed by, against BULK_SLICE_MS (lib/constants.ts): a CSV import's flushes
// (services/csv-import.ts), a clean, formula or lookup column's fill and follow (services/derived-write.ts), a
// column added from an answer (services/answer-field-fill.ts) and a run start's seed while such columns read the
// run's (lib/placeholder-cells.ts, lib/placeholder-rule-seed.ts). performance.now, unless a test sets another.
import { performance } from 'perf_hooks';

let now = (): number => performance.now();

export const sliceClock = (): number => now();

// Tests only: `clock` as the slices' clock, or performance.now again with null.
export function setSliceClockForTests(clock: (() => number) | null): void {
  now = clock ?? ((): number => performance.now());
}
