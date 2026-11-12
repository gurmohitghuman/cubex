// A column restore's last transaction (services/trash-restore-column.ts), once its cells have gone through:
// the column listed at its old place with its description and its own setup, or nothing to set up when the
// cells went into a column already there (the item's leftovers); the change log; and the item gone, or kept
// with the cells that didn't go back (restore_name: the column they go into once their rows are back and
// empty there). The change log says what came back, its setup too (restored, or plain and why).
// A clean, formula or lookup column set up again works its rows out by a fill started after the request
// (startFills): its record is 'filling' already, so a restart resumes it as any fill (resumeDerivedFills).
import { db } from '../lib/db';
import { getSheetColumns, touchSheet } from '../lib/sql-helpers';
import { whenSheetFree } from '../lib/sheet-busy';
import { writeColumnDescription } from '../lib/column-descriptions';
import { countOf, logSheetChange } from '../lib/change-log';
import { fillKind } from '../lib/setup-versions/spec';
import { getTrashItem } from '../lib/trash/store';
import { columnSetupOf, droppedRefsOf, listAt } from '../lib/trash/column-restore';
import { droppedEntry, stillDropped } from '../lib/trash/column-refs-words';
import { runDerivedFill } from './derived-fill';
import { cleanKind } from './clean-kind';
import { formulaKind } from './formula-kind';
import { lookupKind } from './lookup-kind';
import { lookupFillStarted } from './lookup-fill-changes';
import { writeColumnSetup, type SetupPlan } from './trash-restore-column-setup';

export interface FillStart { sheetId: string; table: string; id: string }
export interface Finished {
  position: number; plan: SetupPlan; runId: string | null; restored: number; skipped: number; kept: number;
  into: boolean; fill: FillStart | null;
}

// Call inside an .immediate() transaction, with the sheet busy.
export function finishColumnRestore(itemId: number, sheetId: string, userId: string, name: string): Finished {
  const item = getTrashItem(itemId, userId)!;
  const own = columnSetupOf(item);
  const into = item.restore_into === 1 && getSheetColumns(sheetId, userId, false).includes(name);
  const plan: SetupPlan = { kind: own.fill ? fillKind(own.fill) : 'plain', problem: null, taken: [] };
  let position = getSheetColumns(sheetId, userId, false).indexOf(name);
  let written: { runId: string | null; fill: { table: string; id: string } | null } = { runId: null, fill: null };
  if (!into) {
    position = listAt(sheetId, userId, name, item.column_position);
    if (own.description) writeColumnDescription(sheetId, userId, name, own.description);
    written = writeColumnSetup(sheetId, userId, own, name, plan, item.restore_keys === 1);
  }
  db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(sheetId, userId);
  touchSheet(sheetId, userId);
  const old = item.column_name!;
  const dropped = [...droppedRefsOf(item).filter(r => stillDropped(r, name !== old)), ...plan.taken]
    .map(r => droppedEntry(r, name, old, 'app', sheetId)).map(e => ({ where: e.where, did: e.did }));
  const cells = countOf(item.restored, 'cell');
  // Its setup: restored, or why it came back plain (a restore past its wait answered before this was known).
  const setup = { kind: plan.kind, restored: plan.kind !== 'plain' && plan.problem === null,
    ...(plan.problem ? { why: plan.problem } : {}) };
  logSheetChange(sheetId, userId, 'column_restored', into
    ? `Restored ${cells} of the column "${old}" into "${name}" from the trash`
    : `Restored the column "${old}"${name === old ? '' : ` as "${name}"`} from the trash (${cells} back)`,
  { column: name, detail: { trash_id: itemId, old_name: old, cells: item.restored, skipped: item.restore_skipped,
    kept: item.restore_kept, ...(into ? {} : { setup }), references_dropped: dropped } });
  if (item.row_count <= 0) {
    db.prepare('DELETE FROM trash_rows WHERE item_id = ?').run(itemId);
    db.prepare('DELETE FROM trash_items WHERE id = ?').run(itemId);
  } else {
    // Its cells whose rows were gone wait here, for that column; what it dropped was said already.
    db.prepare(`UPDATE trash_items SET state = 'kept', restore_name = ?, restore_cursor = 0, restore_into = 0,
      restored = 0, restore_skipped = 0, restore_kept = 0, restore_keys = 0, column_dropped = '[]' WHERE id = ?`)
      .run(name, itemId);
  }
  return { position, plan, runId: written.runId, restored: item.restored, skipped: item.restore_skipped,
    kept: item.restore_kept, into, fill: written.fill ? { sheetId, ...written.fill } : null };
}

// After the request that restored (a multi-item restore never takes a sheet mid-loop): each fill takes its
// sheet once it is free.
export function startFills(fills: FillStart[]): void {
  if (fills.length === 0) return;
  setImmediate(() => {
    for (const f of fills) {
      const run = f.table === 'clean_columns' ? () => runDerivedFill(cleanKind, f.id)
        : f.table === 'formula_columns' ? () => runDerivedFill(formulaKind, f.id)
          : () => { lookupFillStarted(f.id); return runDerivedFill(lookupKind, f.id); };
      const busy = f.table === 'clean_columns' ? cleanKind.busy : f.table === 'formula_columns' ? formulaKind.busy
        : lookupKind.busy;
      whenSheetFree(f.sheetId, busy, run)
        .catch(err => console.error(`Working out the restored column on sheet ${f.sheetId} failed:`, err));
    }
  });
}
