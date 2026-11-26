// manage_sheet's test actions (tools-structure.ts): try column changes on sample rows in a hidden copy of the
// sheet, then apply them or discard them (services/sheet-test-*.ts; REST /v1/sheets/:id/test does the same).
import { verifySheetInTable } from '../lib/sheet-crud-helpers';
import { TEST_ACTIONS } from '../lib/sheet-test-hold';
import { SHEET_TEST_MAX_ROWS, SHEET_TEST_ROWS } from '../lib/constants';
import { startSheetTest } from '../services/sheet-test-start';
import { addTestRows } from '../services/sheet-test-add';
import { applySheetTest } from '../services/sheet-test-apply';
import { discardSheetTest } from '../services/sheet-test-end';
import { McpAuthCtx, ok, err, missingScope, type ErrResult, type OkResult } from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';

export { TEST_ACTIONS };
export type TestAction = typeof TEST_ACTIONS[number];

// What manage_sheet's description says of them; the rest is in its guide (guides/structure.ts).
export const TEST_WORDS = 'test tries column changes on sample rows: it copies the sheet\'s top rows (rows, default '
  + `${SHEET_TEST_ROWS}, or row_ids; at most ${SHEET_TEST_MAX_ROWS}) and its setup into a hidden copy, `
  + 'test.test_sheet_id, where you change and run columns with the usual tools (runs there cost as usual; a list '
  + 'enrichment can\'t run there). Meanwhile the sheet takes no changes and its webhook deliveries wait. '
  + 'test_add_rows adds rows to it. apply_test is a dry run unless dry_run is false (then it needs the run scope): '
  + 'it makes the copy\'s setup the sheet\'s and puts the sample rows\' results back; nothing runs on the other '
  + 'rows. discard_test drops the copy. Either ends the test. The test actions answer test, not the tab list.';

export interface TestArgs {
  table_id: string; sheet_id?: string; row_ids?: string[]; rows?: number; how?: 'top' | 'random';
  dry_run?: boolean;
}

type Answer = Promise<OkResult<ToolAnswer<'manage_sheet'>> | ErrResult>;

export async function runTestAction(ctx: McpAuthCtx, action: TestAction, a: TestArgs): Answer {
  if (!a.sheet_id) return err(`sheet_id is required for ${action}`);
  if (!verifySheetInTable(a.sheet_id, a.table_id, ctx.userId)) return err('Sheet not found');
  if (action === 'test') {
    const out = await startSheetTest(ctx.userId, a.sheet_id, { rowIds: a.row_ids, rows: a.rows });
    return 'fail' in out ? err(out.message) : ok({ test: out.ok, changed: [] });
  }
  if (action === 'test_add_rows') {
    const out = addTestRows(ctx.userId, a.sheet_id, { how: a.how, rows: a.rows, rowIds: a.row_ids });
    if ('fail' in out) return err(out.message);
    const { added, ...test } = out.ok;
    return ok({ test, added, changed: [] });
  }
  if (action === 'discard_test') {
    const out = discardSheetTest(ctx.userId, a.sheet_id);
    return 'fail' in out ? err(out.message) : ok({ test: out.ok, changed: [] });
  }
  const dryRun = a.dry_run !== false;
  if (!dryRun) {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
  }
  const out = await applySheetTest(ctx.userId, a.sheet_id, { dryRun, hasSecretsScope: ctx.scopes.has('secrets') });
  return 'fail' in out ? err(out.message) : ok({ test: out.ok.test, apply: out.ok, changed: [] });
}
