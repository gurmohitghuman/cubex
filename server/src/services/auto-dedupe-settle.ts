// Auto-dedupe's checks inside the transaction that adds or edits rows: rows
// that arrived (a webhook delivery, append_rows, list rows, transfer_rows)
// and rows a person or an agent typed a new key into (the grid, update_cells).
// Each row's key is read and stored; when other rows share it, the oldest (or
// newest) stays and the rest go to the trash. When the keys aren't current
// yet (being built, or more rows written meanwhile than fit
// AUTO_DEDUPE_INLINE_MS), or a row that should go can't go now
// (auto-dedupe-remove.ts), the check waits for the background round
// (auto-dedupe-checks.ts). Values written by runs and other filled columns,
// and rows a restore brings back, are stored but never checked.
import { db } from '../lib/db';
import { sheetBusyWith } from '../lib/sheet-busy';
import { AUTO_DEDUPE_CHECK_ROWS, AUTO_DEDUPE_INLINE_MS, AUTO_DEDUPE_INLINE_ROWS } from '../lib/constants-dedupe';
import { whoGoes, type AutoDedupeKeep } from '../lib/auto-dedupe/key';
import { autoDedupeOf, queueCheckRows, storedKey, type AutoDedupe } from '../lib/auto-dedupe/store';
import { drainWithin, readKeyCells, writeKeys } from './auto-dedupe-index';
import { AutoDedupeRemoval, type RemovedRow } from './auto-dedupe-remove';

// What auto-dedupe did to the rows a write added or edited.
export interface AutoDedupeOutcome {
  column: string;
  keep: AutoDedupeKeep;
  removed: RemovedRow[];      // rows that went (the new ones, or older ones they replaced)
  trashId: number | null;     // their batch in the trash (null: Settings keeps nothing)
  seqs: number[];             // their places in it (a restore of just these)
  waiting: number;            // rows whose check waits for the background round
}

// One row's check, its key stored and current: 'done'; 'wait' when a row that
// should go can't go now; 'more' when more than `budget` rows should go and
// some of the first ones went (check it again for the rest).
export function checkRow(removal: AutoDedupeRemoval, rid: number, key: string, budget: number):
  'done' | 'wait' | 'more' {
  const s = removal.s;
  if (storedKey(s.id, rid) !== key) return 'done';
  const span = db.prepare('SELECT MIN(rid) AS lo, MAX(rid) AS hi FROM auto_dedupe_keys WHERE dedupe_id = ? AND key = ?')
    .get(s.id, key) as { lo: number; hi: number };
  const goes = whoGoes(s.keep, rid, span.lo, span.hi);
  if (goes === 'none') return 'done';
  if (goes === 'self') {
    if (!removal.canRemove(rid)) return 'wait';
    removal.remove([rid]);
    return 'done';
  }
  const others = db.prepare(`SELECT rid FROM auto_dedupe_keys WHERE dedupe_id = ? AND key = ? AND rid <> ?
    ORDER BY rid LIMIT ?`).pluck().all(s.id, key, rid, budget + 1) as number[];
  const first = others.slice(0, budget);
  const now = first.filter(r => removal.canRemove(r));
  removal.remove(now);
  if (others.length > budget && now.length > 0) return 'more';
  return now.length < others.length ? 'wait' : 'done';
}

// Inside the write's transaction, after its rows are in. `rids`: the rowids it
// added ('arrived') or whose key cell it wrote ('edited'; a key that didn't
// change isn't checked). Null when the sheet has no auto-dedupe. Its work is a
// savepoint of that transaction: if it fails, only it is undone and the rows
// are kept as written (a webhook delivery or an append is never lost to it).
export function settleRows(
  sheetId: string, userId: string, rids: readonly number[], how: 'arrived' | 'edited',
): AutoDedupeOutcome | null {
  if (rids.length === 0) return null;
  const s = autoDedupeOf(sheetId, userId);
  if (!s) return null;
  try {
    return db.transaction(() => settle(s, rids, how))();
  } catch (err) {
    console.error(`Auto-dedupe couldn't check rows of sheet ${sheetId}; they were kept:`, err);
    // Rows that arrived are checked later (an edit's check needs the key it replaced, which is gone).
    if (how === 'arrived') try { queueCheckRows(s.id, rids); } catch { /* the rows are kept either way */ }
    return null;
  }
}

// A CSV replace is under way (services/csv-import.ts): the rows it replaces
// go to the trash a slice at a time, so a row arriving meanwhile would be
// judged against rows about to go. Its check waits for the replace's own
// checks (or goes with the setting, when the new file has no key column).
const beingReplaced = (sheetId: string): boolean =>
  !!db.prepare('SELECT 1 FROM import_jobs WHERE sheet_id = ? AND is_replace = 1').get(sheetId);

function settle(s: AutoDedupe, rids: readonly number[], how: 'arrived' | 'edited'): AutoDedupeOutcome {
  const sheetId = s.sheet_id;
  const out: AutoDedupeOutcome = {
    column: s.column_name, keep: s.keep, removed: [], trashId: null, seqs: [], waiting: 0,
  };
  const sorted = [...new Set(rids)].sort((a, b) => a - b);
  const keys = writeKeys(s, sorted, readKeyCells(s, sorted));
  const toCheck = sorted.filter(rid => {
    const k = keys.get(rid);
    return !!k && k.now !== null && (how === 'arrived' || k.now !== k.was);
  });
  if (toCheck.length === 0) return out;
  // Every other row's key must be current before any match is trusted, and
  // the rows a CSV replace is sending to the trash are no match: they wait.
  if (s.build_cursor !== null || beingReplaced(sheetId) || !drainWithin(s, AUTO_DEDUPE_INLINE_MS, sorted)) {
    queueCheckRows(s.id, toCheck);
    out.waiting = toCheck.length;
    return out;
  }
  const removal = new AutoDedupeRemoval(s, new Set(how === 'arrived' ? sorted : []), !sheetBusyWith(sheetId));
  const waits: number[] = [];
  for (const rid of toCheck) {
    const room = AUTO_DEDUPE_INLINE_ROWS - removal.count;
    const key = keys.get(rid)!.now!;
    const result = room > 0 ? checkRow(removal, rid, key, Math.min(AUTO_DEDUPE_CHECK_ROWS, room)) : 'wait';
    if (result !== 'done') waits.push(rid);
  }
  if (waits.length > 0) queueCheckRows(s.id, waits, Date.now());
  const { trashId, seqs } = removal.finish();
  return { ...out, removed: removal.removed, trashId, seqs, waiting: waits.length };
}

// Inside an edit's transaction (update_cells): the rows whose key cell it
// wrote. An edit to other cells leaves a row's key alone, so it isn't checked.
export function settleEdits(
  sheetId: string, userId: string, edits: ReadonlyArray<{ rid: number; columns: readonly string[] }>,
): AutoDedupeOutcome | null {
  const s = autoDedupeOf(sheetId, userId);
  if (!s) return null;
  return settleRows(sheetId, userId, edits.filter(e => e.columns.includes(s.column_name)).map(e => e.rid), 'edited');
}

// What the grid's autosave hears (PUT /:id/data): the rows that went, by
// position, and where they are in the trash (its toast restores just those).
export interface GridAutoDedupe {
  column: string; keep: AutoDedupeKeep; removed: number[]; trashId: number | null; seqs: number[]; waiting: number;
}

// Inside the grid write's transaction: the rows whose key cell it edited.
export function settleGridEdits(
  sheetId: string, userId: string, edits: ReadonlyArray<{ column: string; rowIndex: number }>,
): GridAutoDedupe | null {
  const s = autoDedupeOf(sheetId, userId);
  if (!s) return null;
  const indexes = [...new Set(edits.filter(e => e.column === s.column_name).map(e => e.rowIndex))];
  if (indexes.length === 0) return null;
  const rids = db.prepare(`SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index IN (SELECT value FROM json_each(?))`).pluck().all(sheetId, userId, JSON.stringify(indexes)) as
    number[];
  const d = settleRows(sheetId, userId, rids, 'edited');
  if (!d || (d.removed.length === 0 && d.waiting === 0)) return null;
  return {
    column: d.column, keep: d.keep, removed: d.removed.map(r => r.index), trashId: d.trashId, seqs: d.seqs,
    waiting: d.waiting,
  };
}
