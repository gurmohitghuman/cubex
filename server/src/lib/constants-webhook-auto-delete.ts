import { envInt } from './env-int';

// Auto-delete on a webhook sheet (services/webhook-auto-delete*.ts, docs/webhooks.md#auto-delete).
// Rows kept when none is given.
export const AUTO_DELETE_KEEP_DEFAULT = 100;
// The most rows it can be told to keep. Each slice finds the newest row that may leave by walking the sheet's
// index past the kept rows (about 5 ms at 100,000).
export const AUTO_DELETE_KEEP_MAX = 100_000;
// How often it looks at every sheet with auto-delete on.
export const AUTO_DELETE_SWEEP_MS = envInt('AUTO_DELETE_SWEEP_MS', 5_000);
// Rows leaving in one slice (one transaction: copied, then deleted), rows looked at to find them, and slices a
// sheet gets each sweep: at most 5,000 rows a sweep, 20,000 looked at.
export const AUTO_DELETE_SLICE_ROWS = 500;
export const AUTO_DELETE_SCAN_ROWS = 2_000;
export const AUTO_DELETE_SLICES_PER_SWEEP = 10;
// Auto-run's own runs come and go between its sweeps, and auto-delete goes in between. Kept out by them this
// long with finished rows waiting, it asks the sheet to start no new auto-run for AUTO_DELETE_YIELD_MS
// (lib/sheet-yield.ts), as a person's delete does, but for less time.
export const AUTO_DELETE_STARVED_MS = envInt('AUTO_DELETE_STARVED_MS', 60_000);
export const AUTO_DELETE_YIELD_MS = envInt('AUTO_DELETE_YIELD_MS', 30_000);
