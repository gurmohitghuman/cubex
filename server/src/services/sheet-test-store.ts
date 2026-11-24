// A sheet's test (migration 070, services/sheet-test*.ts): the record, read by the sheet tested or by its copy,
// and the answer the app, REST and MCP give for it.
import { db } from '../lib/db';

export interface TestRecord {
  id: string; user_id: string; sheet_id: string; test_sheet_id: string; state: 'open' | 'ending';
  outcome: 'applied' | 'discarded' | null; started_at: string;
}

// What a caller sees of a test.
export interface TestView {
  test_id: string; sheet_id: string; test_sheet_id: string; table_id: string; sheet_name: string;
  rows: number; started_at: string; state: 'open' | 'ending';
}

const COLUMNS = 'id, user_id, sheet_id, test_sheet_id, state, outcome, started_at';

// The test of a sheet (the one tested), or of the copy itself.
export function testOfSheet(sheetId: string, userId: string): TestRecord | null {
  return (db.prepare(`SELECT ${COLUMNS} FROM sheet_tests WHERE (sheet_id = ? OR test_sheet_id = ?) AND user_id = ?`)
    .get(sheetId, sheetId, userId) as TestRecord | undefined) ?? null;
}

export const testRowCount = (testId: string): number =>
  db.prepare('SELECT COUNT(*) FROM sheet_test_rows WHERE test_id = ?').pluck().get(testId) as number;

export function testView(t: TestRecord): TestView {
  const sheet = db.prepare('SELECT table_id, name FROM sheets WHERE id = ?').get(t.sheet_id) as
    { table_id: string; name: string };
  return {
    test_id: t.id, sheet_id: t.sheet_id, test_sheet_id: t.test_sheet_id, table_id: sheet.table_id,
    sheet_name: sheet.name, rows: testRowCount(t.id), started_at: t.started_at, state: t.state,
  };
}

// Every test of the account's sheets in a state (boot holds the open ones again and finishes the ending ones).
export function testsIn(state: TestRecord['state']): TestRecord[] {
  return db.prepare(`SELECT ${COLUMNS} FROM sheet_tests WHERE state = ? ORDER BY rowid`).all(state) as TestRecord[];
}
