import { envInt, envMs } from './env-int';

// Setups (lib/setups/, services/setup-*.ts). Guards, not quotas: a step makes
// at least one column, and a sheet holds at most MAX_COLUMNS_PER_SHEET.
export const MAX_SETUP_STEPS = 30;
export const MAX_SETUP_KEYS = 50;
export const MAX_SETUP_NAME_CHARS = 100;
export const MAX_SETUP_DESCRIPTION_CHARS = 1000;
// The whole spec as stored or imported (prompts and request bodies included).
export const MAX_SETUP_SPEC_BYTES = 512 * 1024;
// How often the runner moves setups being used along (services/setup-runner.ts).
export const SETUP_SWEEP_MS = envMs('SETUP_SWEEP_MS', 3000);
// A test of a setup on the first rows of a sheet takes at most this many.
export const MAX_SETUP_TEST_ROWS = 1000;
// Column runs (services/column-run*.ts): chosen run columns on chosen rows, kept as a setup run.
// row_ids are kept in its record; more rows are chosen with a where.
export const MAX_COLUMN_RUN_COLUMNS = 20;
export const MAX_COLUMN_RUN_ROW_IDS = 10_000;
// An exported file's format, checked on import.
export const SETUP_FILE_FORMAT = 'cubex-setup';
export const SETUP_FILE_VERSION = 1;

// Setup versions (lib/setup-versions/, services/setup-version-*.ts). Guards,
// not quotas. A sheet keeps at most this many; at the cap a restore's own copy
// of the setup it replaces takes the place of the oldest such copy.
export const MAX_SETUP_VERSIONS_PER_SHEET = 100;
// One version's spec as stored: every column's setup, prompts and request bodies included.
export const MAX_SETUP_VERSION_BYTES = 4 * 1024 * 1024;
// A value in a version's diff is cut to this many characters for agents and
// API callers (answers stay bounded); the app shows prompts and bodies whole.
export const SETUP_VERSION_DIFF_CHARS = 400;
export const SETUP_VERSION_DIFF_CHARS_APP = 20_000;

// A setup called on items without a sheet (services/setup-call.ts): at most this many items in one call, and its
// hidden working table kept this many hours after the call finishes (its results with it). A working table whose
// call never started (a crash between the two, or an upload link never used) goes this many hours after no upload
// link can still be filling it (services/setup-call.ts).
export const SETUP_CALL_MAX_ITEMS = 100;
export const SETUP_CALL_KEEP_HOURS = envInt('SETUP_CALL_KEEP_HOURS', 24);
export const SETUP_CALL_ORPHAN_HOURS = 1;
// How often the sweep looks for working tables to remove.
export const SETUP_CALL_SWEEP_MS = 10 * 60_000;
// The most call_sheets rows (migration 075) one sweep drops.
export const CALL_SHEETS_PRUNE_ROWS = 1000;
// Scheduled reruns (services/run-schedule*.ts): at most this many schedules on one sheet or table, and how often the
// sweep looks for schedules due (a firing is at most this late).
export const RUN_SCHEDULES_PER_TARGET = envInt('RUN_SCHEDULES_PER_SHEET', 20);
export const RUN_SCHEDULE_SWEEP_MS = envMs('RUN_SCHEDULE_SWEEP_MS', 60_000);
