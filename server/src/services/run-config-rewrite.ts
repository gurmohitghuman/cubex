// Renaming or deleting a column rewrites the runs that name it: their master
// column and configs (lib/http-columns.ts). Auto-run leaves a run per batch,
// so a column can hold tens of thousands of runs, too many for the switch
// transaction. That transaction records the rewrite (run_config_rewrites,
// migration 018) and does the newest page of runs; the rest go a page per
// transaction with the sheet still busy, so nothing that starts or reruns a
// run reads a config half-way. A restart finishes it (resumeRunRewrites).
import { db } from '../lib/db';
import { stayBusyToFinish, whenSheetFree } from '../lib/sheet-busy';
import { pendingPurges, purgeColumnKey } from '../lib/column-purge';
import { yieldToRequests } from '../lib/slices';
import {
  deleteColumnNewest, deleteHttpRunsPage, renameColumnNewest, renameHttpRunsPage, RUNS_PAGE,
} from '../lib/http-columns';
import { forgetPruneColumns } from './answer-prune';

interface Rewrite { id: number; sheet_id: string; user_id: string; old_name: string; new_name: string | null;
  before_rowid: number }

// One page, and where the rewrite got to (done: the record goes). Call inside a transaction.
function step(r: Rewrite): boolean {
  const next = r.new_name === null
    ? deleteHttpRunsPage(r.sheet_id, r.user_id, r.old_name, r.before_rowid, RUNS_PAGE)
    : renameHttpRunsPage(r.sheet_id, r.user_id, r.old_name, r.new_name, r.before_rowid, RUNS_PAGE);
  if (next === null) {
    db.prepare('DELETE FROM run_config_rewrites WHERE id = ?').run(r.id);
    return false;
  }
  db.prepare('UPDATE run_config_rewrites SET before_rowid = ? WHERE id = ?').run(next, r.id);
  return true;
}

// Inside the switch transaction: the column's own newest runs move at once
// (it keeps its runs for the panel, spend and column types meanwhile), and
// the rewrite of all the sheet's runs is recorded. finishRunRewrites, called
// at the start of every rename and delete, leaves no older rewrite pending.
export function recordRunRewrite(sheetId: string, userId: string, oldName: string, newName: string | null): void {
  if (newName === null) deleteColumnNewest(sheetId, userId, oldName);
  else renameColumnNewest(sheetId, userId, oldName, newName);
  db.prepare(`INSERT INTO run_config_rewrites (sheet_id, user_id, old_name, new_name, before_rowid)
    VALUES (?, ?, ?, ?, ?)`).run(sheetId, userId, oldName, newName, Number.MAX_SAFE_INTEGER);
  forgetPruneColumns(sheetId);
}

// The sheet's rewrites in the order they were made, a page per transaction.
// Call with the sheet busy.
export async function finishRunRewrites(sheetId: string): Promise<void> {
  const next = db.prepare('SELECT * FROM run_config_rewrites WHERE sheet_id = ? ORDER BY id LIMIT 1');
  let worked = false;
  for (;;) {
    const r = next.get(sheetId) as Rewrite | undefined;
    if (!r) break;
    db.transaction(() => step(r)).immediate();
    worked = true;
    await yieldToRequests();
  }
  // Open tabs read the column types and the ⚡ spend again.
  if (worked) {
    const owner = db.prepare('SELECT user_id FROM sheets WHERE id = ?').pluck().get(sheetId) as string | undefined;
    if (owner) {
      db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`).run(sheetId, owner);
    }
  }
}

// After the switch: the runs' rewrite, then the old key's strip (a step that
// fails keeps the sheet busy and is retried, as the field fill is).
export async function finishColumnChange(sheetId: string, userId: string, strip: string): Promise<void> {
  try {
    await finishRunRewrites(sheetId);
    await purgeColumnKey(sheetId, userId, strip);
  } catch (err) {
    console.error(`Finishing the column change on sheet ${sheetId} failed, retrying:`, err);
    stayBusyToFinish(sheetId, 'finishing a column change', async () => {
      await finishRunRewrites(sheetId);
      if (pendingPurges(sheetId).has(strip)) await purgeColumnKey(sheetId, userId, strip);
    });
  }
}

// At boot, before serving (and before resumeColumnPurges): each sheet with a
// rewrite left is marked busy at once, and its key strips are finished in the
// same busy window, so nothing gets in between.
export function resumeRunRewrites(): void {
  const sheets = db.prepare('SELECT DISTINCT sheet_id, user_id FROM run_config_rewrites').all() as
    Array<{ sheet_id: string; user_id: string }>;
  for (const { sheet_id: sheetId, user_id: userId } of sheets) {
    const finish = async () => {
      await finishRunRewrites(sheetId);
      for (const name of pendingPurges(sheetId)) await purgeColumnKey(sheetId, userId, name);
    };
    whenSheetFree(sheetId, 'finishing a column change', async () => {
      try { await finish(); } catch (err) {
        // Keep the sheet busy and retry: a rerun must never read a half-rewritten config.
        console.error(`Finishing the column change on sheet ${sheetId} failed, retrying:`, err);
        stayBusyToFinish(sheetId, 'finishing a column change', finish);
      }
    }).catch(err => console.error(`Finishing the column change on sheet ${sheetId} failed:`, err));
  }
}
