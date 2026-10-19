import { envInt } from './env-int';

// Setups (lib/setups/, services/setup-*.ts). Guards, not quotas: a step makes
// at least one column, and a sheet holds at most MAX_COLUMNS_PER_SHEET.
export const MAX_SETUP_STEPS = 30;
export const MAX_SETUP_KEYS = 50;
export const MAX_SETUP_NAME_CHARS = 100;
export const MAX_SETUP_DESCRIPTION_CHARS = 1000;
// The whole spec as stored or imported (prompts and request bodies included).
export const MAX_SETUP_SPEC_BYTES = 512 * 1024;
// How often the runner moves setups being used along (services/setup-runner.ts).
export const SETUP_SWEEP_MS = envInt('SETUP_SWEEP_MS', 3000);
// A test of a setup on the first rows of a sheet takes at most this many.
export const MAX_SETUP_TEST_ROWS = 1000;
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
