// A sheet whose column changes are being tried on a test copy (services/sheet-test*.ts) is read-only until the
// test is applied or discarded. lib/sheet-busy.ts reports it busy with TESTING to every change, appends too, so
// edits wait (autosave retries a busy answer) and auto-run, follows and setup runs hold; reads, exports and
// lookups from other sheets go on (rowsMovingOn: a test moves no row). Kept in memory on the API thread and filled
// at boot from sheet_tests (state 'open'): no run goes on such a sheet, so no worker thread writes to it.
const tested = new Set<string>();

export const TESTING = 'testing changes on sample rows';

export const sheetUnderTest = (sheetId: string): boolean => tested.has(sheetId);

export function holdForTest(sheetId: string): void {
  tested.add(sheetId);
}

export function releaseTestHold(sheetId: string): void {
  tested.delete(sheetId);
}

// A test's copy once its test has ended (applied or discarded), until it is deleted: every change refused as busy
// CLOSING, so nothing new starts on it; the purge that deletes it isn't held up (sheetHeld leaves it out).
const closing = new Set<string>();

export const CLOSING = 'closing (a test copy whose test has ended)';

export const copyClosing = (sheetId: string): boolean => closing.has(sheetId);

export function holdClosingCopy(sheetId: string): void {
  closing.add(sheetId);
}

export function releaseClosingCopy(sheetId: string): void {
  closing.delete(sheetId);
}

// The sheet routes (app and /api/v1) that act on its test: the busy guard lets them through, as each checks the
// sheet itself (routes/sheets-test.ts, api-v1-sheet-test.ts).
export const TEST_PATHS = ['/test', '/test/rows', '/test/apply', '/test/discard'];
// The same for MCP: manage_sheet's test actions (mcp/tools-sheet-test.ts), let through by its busy guard.
export const TEST_ACTIONS = ['test', 'test_add_rows', 'apply_test', 'discard_test'] as const;
