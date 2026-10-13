// Renaming or deleting a column rewrites the runs that name it: the sheet's
// own runs (master column, configs: lib/http-columns.ts), then the list jobs
// adding rows into the sheet from another one (the fields they keep, the
// columns they copy into: lib/list-dest-columns.ts). Auto-run leaves a run per
// batch, so a column can hold tens of thousands of runs, and as many can add
// rows into one sheet: too many for the switch transaction. That transaction
// records the rewrite (run_config_rewrites, migrations 018 and 021) and does
// the column's own newest page of runs; the rest go a page per transaction
// with the sheet still busy, so nothing that starts or reruns a run reads a
// config half-way: a run start refuses a busy destination, and list results
// wait for it (services/enrich-list-dest.ts, enrich-list-drain.ts). A restart
// finishes it (resumeRunRewrites).
import { db } from '../lib/db';
import { stayBusyToFinish, whenSheetFree } from '../lib/sheet-busy';
import { pendingPurges, purgeColumnKey } from '../lib/column-purge';
import { yieldToRequests } from '../lib/slices';
import {
  deleteColumnNewest, deleteHttpRunsPage, renameColumnNewest, renameHttpRunsPage, RUNS_PAGE,
} from '../lib/http-columns';
import { deleteListDestPage, renameListDestPage } from '../lib/list-dest-columns';
import { forgetPruneColumns } from './answer-prune';

interface Rewrite { id: number; sheet_id: string; user_id: string; old_name: string; new_name: string | null;
  before_rowid: number; dest_before_rowid: number }

// One page: the sheet's own runs first, then the runs adding rows into it
// (each pass's cursor goes to 0 when it is done), and the record goes once
// both are. Call inside a transaction.
function step(r: Rewrite): void {
  const { sheet_id: sheetId, user_id: userId, old_name: oldName, new_name: newName } = r;
  if (r.before_rowid > 0) {
    const next = newName === null
      ? deleteHttpRunsPage(sheetId, userId, oldName, r.before_rowid, RUNS_PAGE)
      : renameHttpRunsPage(sheetId, userId, oldName, newName, r.before_rowid, RUNS_PAGE);
    db.prepare('UPDATE run_config_rewrites SET before_rowid = ? WHERE id = ?').run(next ?? 0, r.id);
  } else if (r.dest_before_rowid > 0) {
    const next = newName === null
      ? deleteListDestPage(sheetId, userId, oldName, r.dest_before_rowid, RUNS_PAGE)
      : renameListDestPage(sheetId, userId, oldName, newName, r.dest_before_rowid, RUNS_PAGE);
    db.prepare('UPDATE run_config_rewrites SET dest_before_rowid = ? WHERE id = ?').run(next ?? 0, r.id);
  } else {
    db.prepare('DELETE FROM run_config_rewrites WHERE id = ?').run(r.id);
  }
}

// Inside the switch transaction: the column's own newest runs move at once
// (it keeps its runs for the panel, spend and column types meanwhile), and
// the rewrite of all the sheet's runs, and of the runs into it, is recorded.
// Nothing acts on a list job's destination names while the sheet is busy (the
// drain, a run start, picking fields: they wait or refuse), so the runs into
// it all wait for the pages. finishRunRewrites, called at the start of every
// rename and delete, leaves no older rewrite pending.
export function recordRunRewrite(sheetId: string, userId: string, oldName: string, newName: string | null): void {
  if (newName === null) deleteColumnNewest(sheetId, userId, oldName);
  else renameColumnNewest(sheetId, userId, oldName, newName);
  db.prepare(`INSERT INTO run_config_rewrites (sheet_id, user_id, old_name, new_name, before_rowid,
    dest_before_rowid) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sheetId, userId, oldName, newName, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
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
