// manage_sheet's test actions (tools-structure.ts): try column changes on sample rows in a hidden copy of the
// sheet, then apply them or discard them (services/sheet-test-*.ts; REST /v1/sheets/:id/test does the same).
import { verifySheetInTable } from '../lib/sheet-crud-helpers';
import { TEST_ACTIONS } from '../lib/sheet-test-hold';
import { startSheetTest } from '../services/sheet-test-start';
import { addTestRows } from '../services/sheet-test-add';
import { applySheetTest } from '../services/sheet-test-apply';
import { discardSheetTest } from '../services/sheet-test-end';
import { McpAuthCtx, ok, err, missingScope, type ErrResult, type OkResult } from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';

export { TEST_ACTIONS };
export type TestAction = typeof TEST_ACTIONS[number];

export const TEST_WORDS = 'test copies the top rows (or row_ids) and the setup to a hidden copy, test.test_sheet_id, '
  + 'to change and run columns on (not list enrichments); the sheet takes no changes meanwhile. test_add_rows adds '
  + 'more. apply_test (a dry run unless dry_run is false) makes the copy\'s setup the sheet\'s, keeping sample '
  + 'answers; discard_test drops it. ';

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
