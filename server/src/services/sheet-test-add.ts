// "Add rows" to an open test (services/sheet-test*.ts): more of the sheet's rows copied in as they are, from the
// top (the next ones the test doesn't hold), at random, or those chosen, up to the test's limit. The copy's clean,
// formula and lookup columns work the new rows out as they arrive there; nothing paid runs.
import { db } from '../lib/db';
import { sheetBusyWith } from '../lib/sheet-busy';
import { SHEET_TEST_MAX_ROWS, SHEET_TEST_ROWS } from '../lib/constants';
import { copyRowsIntoTest, randomRows, rowsInTest, sheetRowsOf, topRows } from './sheet-test-rows';
import { testOfSheet, testView, type TestView } from './sheet-test-store';
import type { RunFail } from './run-shared';

export interface AddRowsInput { how?: unknown; rowIds?: unknown; rows?: unknown }

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

export function addTestRows(userId: string, sheetId: string, input: AddRowsInput):
  { ok: TestView & { added: number } } | RunFail {
  const t = testOfSheet(sheetId, userId);
  if (!t) return { fail: 'not_found', message: 'No test is open on this sheet.' };
  if (t.state !== 'open') return { fail: 'conflict', message: 'This test is closing already.' };
  const busy = sheetBusyWith(t.test_sheet_id);
  if (busy) return { fail: 'conflict', message: `The test copy is busy ${busy}. Try again when that finishes.` };
  const have = rowsInTest(t.id);
  const room = SHEET_TEST_MAX_ROWS - have.size;
  if (room <= 0) return { fail: 'conflict', message: `A test holds at most ${SHEET_TEST_MAX_ROWS} rows.` };
  let ids: string[];
  if (input.rowIds !== undefined && input.rowIds !== null) {
    const asked = input.rowIds;
    if (!Array.isArray(asked) || !asked.length || asked.some(id => typeof id !== 'string')) {
      return bad('row_ids must be a list of row ids.');
    }
    ids = sheetRowsOf(t.sheet_id, userId, asked as string[]);
    if (ids.length < new Set(asked).size) return bad('Some chosen rows aren\'t in the sheet being tested.');
  } else {
    const n = input.rows ?? SHEET_TEST_ROWS;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return bad('rows must be a whole number, 1 or more.');
    if (input.how !== undefined && input.how !== 'top' && input.how !== 'random') {
      return bad('how must be "top" or "random".');
    }
    const take = Math.min(n, room);
    ids = input.how === 'random' ? randomRows(t.sheet_id, userId, take, have) : topRows(t.sheet_id, userId, take, have);
  }
  const added = db.transaction(() => copyRowsIntoTest(t, ids)).immediate();
  if (!added && !ids.length) return { fail: 'conflict', message: 'The test has every row of the sheet already.' };
  return { ok: { ...testView(t), added } };
}
