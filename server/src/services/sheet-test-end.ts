// Ending a test (migration 070): discarded here, or applied (sheet-test-apply.ts writes the sheet first). The
// record turns 'ending' in the transaction that changes the sheet, and the sheet's hold goes in the same turn, so
// the sheet takes changes again at once. Then, in the background: the copy's work stops as a sheet delete stops it
// (its runs cancelled, list runs into it dropped), the copy is deleted once nothing writes it (not trashed: its
// spend records stay, migration 033), the deliveries the sheet kept meanwhile are added (sheet-test-webhooks.ts)
// and the record goes. A restart finishes an ending test and holds an open one's sheet again (resumeSheetTests).
import { db } from '../lib/db';
import { HEAVY_JOB_RETRY_MAX_MS, HEAVY_JOB_RETRY_MS } from '../lib/constants';
import { holdClosingCopy, holdForTest, releaseClosingCopy, releaseTestHold } from '../lib/sheet-test-hold';
import { logSheetChange } from '../lib/change-log';
import { afterRetire, retireSheets } from './trash-sheets';
import { purgeSheet } from './trash-purge';
import { fanOutRunEvents } from './run-hooks-dispatch';
import { sheetWorkGoing } from './sheet-work-going';
import { addHeldDeliveries, resumeHeldDeliveries } from './sheet-test-webhooks';
import { testOfSheet, testsIn, testView, type TestRecord, type TestView } from './sheet-test-store';
import type { RunFail } from './run-shared';

const ending = new Set<string>();

// In the transaction that ends it: the record says so and the sheet's open grids reload.
export function markEnding(t: TestRecord, outcome: 'applied' | 'discarded'): void {
  db.prepare(`UPDATE sheet_tests SET state = 'ending', outcome = ? WHERE id = ? AND state = 'open'`)
    .run(outcome, t.id);
  db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(t.sheet_id, t.user_id);
}

async function finish(t: TestRecord): Promise<void> {
  const retired = db.transaction(() => retireSheets([t.test_sheet_id], t.user_id)).immediate();
  afterRetire(retired, t.user_id);
  // A cancelled run clears its ⏳ first; a fill going holds the copy, so the purge waits for it (false: next try).
  const running = () => { const going = sheetWorkGoing(t.test_sheet_id, t.user_id); return !!going && 'run' in going; };
  for (let wait = 250; running(); wait = Math.min(wait * 2, HEAVY_JOB_RETRY_MS)) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  // Its runs' finish notices go out while it is still known as a copy (only to a webhook a run named).
  while (fanOutRunEvents() > 0) { /* the next batch */ }
  while (!(await purgeSheet(t.test_sheet_id, t.user_id, null))) {
    await new Promise(resolve => setTimeout(resolve, HEAVY_JOB_RETRY_MS));
  }
  // The record goes, and the sheet's open grids are told: one that loaded while the test was closing shows it as
  // it is again.
  db.transaction(() => {
    db.prepare('DELETE FROM sheet_tests WHERE id = ?').run(t.id);
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(t.sheet_id, t.user_id);
  }).immediate();
  releaseClosingCopy(t.test_sheet_id);
  addHeldDeliveries(t.sheet_id, t.user_id);
}

// Finishes an ending test in the background (once at a time), trying again after a failure. Call in the turn that
// committed its end: its copy takes nothing new from then on.
export function finishEnding(t: TestRecord): void {
  holdClosingCopy(t.test_sheet_id);
  if (ending.has(t.id)) return;
  ending.add(t.id);
  void (async () => {
    for (let wait = HEAVY_JOB_RETRY_MS; ; wait = Math.min(wait * 2, HEAVY_JOB_RETRY_MAX_MS)) {
      try { await finish(t); break; }
      catch (err) { console.error(`Ending the test of sheet ${t.sheet_id} failed, retrying:`, err); }
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    ending.delete(t.id);
  })();
}

// Discarding: the sheet is as it was before the test; what ran on the copy is gone with it (its spend counted).
export function discardSheetTest(userId: string, sheetId: string): { ok: TestView } | RunFail {
  const t = testOfSheet(sheetId, userId);
  if (!t) return { fail: 'not_found', message: 'No test is open on this sheet.' };
  if (t.state === 'ending') return { ok: testView(t) };
  db.transaction(() => {
    markEnding(t, 'discarded');
    logSheetChange(t.sheet_id, userId, 'test_discarded', 'Discarded the test of changes on sample rows: the sheet is '
      + 'as it was');
  }).immediate();
  releaseTestHold(t.sheet_id);
  const now = testOfSheet(t.sheet_id, userId) ?? t;
  finishEnding(now);
  return { ok: testView(now) };
}

// At boot, before the server answers: open tests hold their sheets again, ending ones finish, and sheets holding
// deliveries from a test that ended add them.
export function resumeSheetTests(): void {
  for (const t of testsIn('open')) holdForTest(t.sheet_id);
  for (const t of testsIn('ending')) finishEnding(t);
  resumeHeldDeliveries();
}
