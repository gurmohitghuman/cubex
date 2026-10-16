// Setups (lib/setups/, services/setup-*.ts). Guards, not quotas: a step makes
// at least one column, and a sheet holds at most MAX_COLUMNS_PER_SHEET.
export const MAX_SETUP_STEPS = 30;
export const MAX_SETUP_KEYS = 50;
export const MAX_SETUP_NAME_CHARS = 100;
export const MAX_SETUP_DESCRIPTION_CHARS = 1000;
// The whole spec as stored or imported (prompts and request bodies included).
export const MAX_SETUP_SPEC_BYTES = 512 * 1024;
// An exported file's format, checked on import.
export const SETUP_FILE_FORMAT = 'cubex-setup';
export const SETUP_FILE_VERSION = 1;
