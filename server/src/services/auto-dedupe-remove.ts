// Rows auto-dedupe removes, inside the transaction that decided it: into the
// sheet's auto-dedupe batch in the trash (one per sheet a day, kept for the
// days Settings sets from its last row), or gone at once when Settings keeps
// deleted rows 0 days.
//
// A row may go at once when it came in this same transaction (no run, sort or
// other job can have seen it). A row already in the sheet may go only while
// no other job holds the sheet (lib/sheet-busy.ts) and no run is working on
// it: a run writes its results by row position, so removing a row it holds
// would leave results that a later sort binds to another row (the reason the
// grid's delete waits for runs). A check that can't remove such a row waits.
import { db } from '../lib/db';
import { BLANK_CHARS, LIST_MARK, RUNNING_MARK } from '../lib/run-markers';
import { autorunRowsRemoved } from '../lib/autorun-mark';
import { removeRows, sealBatch } from '../lib/trash/move';
import { insertTrashItem, sheetFacts, trashKeeps } from '../lib/trash/store';
import type { AutoDedupe } from '../lib/auto-dedupe/store';
import { bumpDataVersion, sheetHasActiveRun } from './data-plane-shared';
import { widenColumns } from './trash-rows';

export interface RemovedRow { id: string; index: number }

// A cell of the row holds a run's placeholder (⏳) or a list job's "adding" (➕).
function holdsRunWork(rid: number): boolean {
  return !!db.prepare(`SELECT 1 FROM rows r, json_each(r.data) j WHERE r.rowid = ? AND j.type = 'text'
    AND substr(ltrim(j.value, ?), 1, 1) IN (?, ?) LIMIT 1`).get(rid, BLANK_CHARS, RUNNING_MARK, LIST_MARK);
}

// Today's auto-dedupe batch of the sheet, while the sheet keeps its row order
// (a restore puts rows back at their old places only then).
function todaysBatch(s: AutoDedupe, generation: number): number | null {
  return (db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND user_id = ? AND kind = 'rows'
    AND how = 'auto_dedupe' AND state = 'kept' AND row_generation = ? AND date(deleted_at) = date('now')
    ORDER BY id DESC LIMIT 1`).pluck().get(s.sheet_id, s.user_id, generation) as number | undefined) ?? null;
}

// One transaction's removals. Rows to remove are collected (a check's
// decision never depends on whether an earlier one's rows are gone yet: every
// key is written first, and a row that lost stays the loser of its key) and go
// in one move at the end: one statement for many rows, not several per row.
export class AutoDedupeRemoval {
  readonly removed: RemovedRow[] = [];
  private readonly pending = new Set<number>();
  private item: number | null | undefined;
  private seqAfter = 0;
  private runActive: boolean | undefined;
  private olderGone = false;

  // fresh: rows this transaction added. sheetFree: no other job holds the sheet.
  // bump: open tabs reload after it (the checks' slices leave that to their end).
  constructor(readonly s: AutoDedupe, private readonly fresh: ReadonlySet<number>,
    private readonly sheetFree: boolean, private readonly bump = true) {}

  // Rows decided so far (to go, or gone).
  get count(): number { return this.pending.size + this.removed.length; }

  canRemove(rid: number): boolean {
    if (this.fresh.has(rid)) return true;
    if (!this.sheetFree) return false;
    this.runActive ??= sheetHasActiveRun(this.s.sheet_id, this.s.user_id);
    return !this.runActive || !holdsRunWork(rid);
  }

  remove(rids: readonly number[]): void {
    for (const rid of rids) this.pending.add(rid);
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const rids = [...this.pending];
    this.pending.clear();
    const rows = db.prepare(`SELECT id, row_index AS "index" FROM rows WHERE rowid IN (SELECT value FROM json_each(?))
      AND +sheet_id = ? AND +user_id = ?`).all(JSON.stringify(rids), this.s.sheet_id, this.s.user_id) as RemovedRow[];
    removeRows(this.s.sheet_id, this.s.user_id, { rowids: rids }, this.batch());
    this.removed.push(...rows);
    this.olderGone ||= rids.some(rid => !this.fresh.has(rid));
  }

  private batch(): number | null {
    if (this.item !== undefined) return this.item;
    const facts = sheetFacts(this.s.sheet_id, this.s.user_id);
    if (!facts || !trashKeeps(this.s.user_id)) return (this.item = null);
    let id = todaysBatch(this.s, facts.generation);
    if (id === null) {
      id = insertTrashItem({
        userId: this.s.user_id, kind: 'rows', how: 'auto_dedupe', tableId: facts.tableId, sheetId: this.s.sheet_id,
        columns: facts.columns,
      });
      sealBatch(id, this.s.sheet_id, this.s.user_id);
    } else {
      widenColumns(id, facts.columns);
    }
    this.seqAfter = db.prepare(`SELECT MAX(IFNULL((SELECT MAX(seq) FROM trash_rows WHERE item_id = ?), 0), seq_high)
      FROM trash_items WHERE id = ?`).pluck().get(id, id) as number;
    return (this.item = id);
  }

  // The rows go: the batch is kept from now, the setting counts them, open
  // tabs reload, and auto-run's fence follows when a row older than this
  // transaction went (a row it added never reached auto-run: setting its
  // rescan for one would make it drop the run it was starting). Returns the
  // batch and the seqs of this transaction's rows in it.
  finish(): { trashId: number | null; seqs: number[] } {
    this.flush();
    if (this.removed.length === 0) return { trashId: null, seqs: [] };
    const item = this.item ?? null;
    let seqs: number[] = [];
    if (item !== null) {
      db.prepare("UPDATE trash_items SET deleted_at = datetime('now') WHERE id = ?").run(item);
      seqs = db.prepare('SELECT seq FROM trash_rows WHERE item_id = ? AND seq > ? ORDER BY seq').pluck()
        .all(item, this.seqAfter) as number[];
    }
    db.prepare(`UPDATE auto_dedupe SET removed_rows = removed_rows + ?, updated_at = datetime('now')
      WHERE id = ?`).run(this.removed.length, this.s.id);
    if (this.olderGone) autorunRowsRemoved(this.s.sheet_id, this.s.user_id);
    if (this.bump) bumpDataVersion(this.s.sheet_id, this.s.user_id);
    return { trashId: item, seqs };
  }
}
