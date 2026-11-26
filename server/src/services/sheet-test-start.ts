// Starting a test of a sheet's column changes (migration 070): a hidden copy of the sheet in its table
// (sheets.test_of, under the same name: no list shows it) holding the top rows, or those chosen, as they are
// (sheet-test-rows.ts) and the sheet's setup as a setup version's restore writes one (nothing runs, nothing is
// billed). In the copy paid auto-run is off, so a test runs only what the person runs there; clean, formula and
// lookup columns follow as they do on the sheet. From then the sheet is read-only (lib/sheet-test-hold.ts) until
// the test is applied or discarded. Refused while anything writes the sheet's cells (a run, a setup filling it,
// a fill) or it is busy. One test per sheet; a copy can't be tested.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { busyMessage, sheetBusyWith, withSheetBusy } from '../lib/sheet-busy';
import { holdForTest } from '../lib/sheet-test-hold';
import { SHEET_TEST_MAX_ROWS, SHEET_TEST_ROWS } from '../lib/constants';
import { countOf, logSheetChange } from '../lib/change-log';
import { createDefaultView } from './view-store';
import { snapshotSheet } from './setup-version-snapshot';
import { fieldContext, planRestore } from './setup-version-plan';
import { RestoreRefused, writePlan } from './setup-version-apply';
import { sheetWorkGoing, type WorkGoing } from './sheet-work-going';
import { copyRowsIntoTest, sheetRowsOf, topRows } from './sheet-test-rows';
import { testOfSheet, testView, type TestRecord, type TestView } from './sheet-test-store';
import type { VersionSpec } from '../lib/setup-versions/spec';
import type { RunFail } from './run-shared';

export interface StartInput { rowIds?: unknown; rows?: unknown }

const conflict = (message: string): RunFail => ({ fail: 'conflict', message });
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// Why the sheet can't take a test now, or null (busy: whether a busy sheet counts; not inside the start's own hold).
export function testBlocked(sheetId: string, userId: string, busy = true): RunFail | null {
  const going: WorkGoing = sheetWorkGoing(sheetId, userId);
  const own = testOfSheet(sheetId, userId);
  if (own && own.test_sheet_id === sheetId) return conflict('This is a test copy: apply or discard its test instead.');
  if (own?.state === 'open') return conflict('Changes are already being tested on this sheet. Apply or discard that '
    + 'test first.');
  if (own) return conflict('The last test of this sheet is still ending. Try again in a moment.');
  if (going && 'run' in going) return conflict('A run is going on this sheet, or a saved setup is filling it. Stop it '
    + 'or let it finish, then test changes.');
  if (going) return conflict(`"${going.filling}" is still being filled. Let it finish, then test changes.`);
  const what = busy ? sheetBusyWith(sheetId) : null;
  return what ? conflict(busyMessage(what)) : null;
}

// The rows asked for: chosen ids (up to the limit, each the sheet's), or how many from the top.
function rowChoice(input: StartInput): { ids: string[] } | { top: number } | RunFail {
  if (input.rowIds !== undefined && input.rowIds !== null) {
    const ids = input.rowIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string')) {
      return bad('row_ids must be a list of row ids.');
    }
    if (new Set(ids).size > SHEET_TEST_MAX_ROWS) return bad(`A test holds at most ${SHEET_TEST_MAX_ROWS} rows.`);
    return { ids: ids as string[] };
  }
  const n = input.rows ?? SHEET_TEST_ROWS;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > SHEET_TEST_MAX_ROWS) {
    return bad(`rows must be a whole number from 1 to ${SHEET_TEST_MAX_ROWS}.`);
  }
  return { top: n };
}

// The sheet's setup for its copy: paid auto-run off, the rest as it is.
const copySpec = (spec: VersionSpec): VersionSpec => ({
  ...spec,
  columns: spec.columns.map(c => (c.fill && (c.fill.kind === 'ai' || c.fill.kind === 'http')
    ? { ...c, autoRun: null } : c)),
});

// In the start's transaction: the hidden copy, its test record, its rows and its setup.
function makeTest(sheetId: string, userId: string, choice: { ids: string[] } | { top: number }): TestRecord {
  const rowIds = 'ids' in choice ? sheetRowsOf(sheetId, userId, choice.ids) : topRows(sheetId, userId, choice.top,
    new Set());
  const missing = 'ids' in choice ? new Set(choice.ids).size - rowIds.length : 0;
  if (missing > 0) {
    throw new RestoreRefused(bad(missing === 1 ? 'A chosen row isn\'t in this sheet.'
      : `${missing} chosen rows aren't in this sheet.`));
  }
  if (!rowIds.length) throw new RestoreRefused(conflict('This sheet has no rows to test on. Add some first.'));
  const testSheetId = uuidv4();
  db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, description, position, column_order, default_ai_model,
      default_ai_concurrency, test_of)
    SELECT ?, table_id, user_id, name, description, position, '[]', default_ai_model, default_ai_concurrency, id
    FROM sheets WHERE id = ? AND user_id = ?`).run(testSheetId, sheetId, userId);
  createDefaultView(testSheetId, userId);
  const test: TestRecord = { id: uuidv4(), user_id: userId, sheet_id: sheetId, test_sheet_id: testSheetId,
    state: 'open', outcome: null, started_at: '' };
  db.prepare('INSERT INTO sheet_tests (id, user_id, sheet_id, test_sheet_id) VALUES (?, ?, ?, ?)')
    .run(test.id, userId, sheetId, testSheetId);
  const copied = copyRowsIntoTest(test, rowIds);
  // The rows go in first: a clean, formula or lookup column's follow then starts above them (nothing to work out).
  const spec = copySpec(snapshotSheet(sheetId, userId));
  const plan = planRestore(testSheetId, userId, spec, fieldContext(userId, false));
  writePlan(testSheetId, userId, plan, new Map(spec.columns.map(c => [c.name, c])), { hasSecretsScope: true,
    paused: [] });
  // Open grids of the sheet reload, and show it read-only.
  db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(sheetId, userId);
  logSheetChange(sheetId, userId, 'test_started', `Started testing changes on ${countOf(copied, 'sample row')}`,
    { detail: { test_sheet_id: testSheetId } });
  return test;
}

export async function startSheetTest(userId: string, sheetId: string, input: StartInput):
  Promise<{ ok: TestView } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const choice = rowChoice(input);
  if ('fail' in choice) return choice;
  const blocked = testBlocked(sheetId, userId);
  if (blocked) return blocked;
  const out = await withSheetBusy(sheetId, 'starting a test', async (): Promise<{ ok: TestView } | RunFail> => {
    let test: TestRecord;
    try {
      test = db.transaction(() => {
        // Checked again inside the write lock: a run may have started since.
        const now = testBlocked(sheetId, userId, false);
        if (now) throw new RestoreRefused(now);
        return makeTest(sheetId, userId, choice);
      }).immediate();
    } catch (e) {
      if (e instanceof RestoreRefused) return e.out;
      throw e;
    }
    // In the same turn as the commit: no change gets in between.
    holdForTest(sheetId);
    return { ok: testView(testOfSheet(sheetId, userId) ?? test) };
  });
  return 'busy' in out && typeof out.busy === 'string' ? conflict(out.busy) : out as { ok: TestView } | RunFail;
}
