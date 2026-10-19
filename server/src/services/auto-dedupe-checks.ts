// Auto-dedupe's waiting checks (auto_dedupe_checks), made on the API thread a
// short transaction at a time (a budget of rows looked at, rows removed and
// time, then a WAL checkpoint): rows that arrived while the keys were built or
// had a backlog, a CSV import's rows (auto-dedupe-import.ts), and checks whose
// losing row a run held (tried again after AUTO_DEDUPE_RETRY_MS). A round every
// AUTO_DEDUPE_TICK_MS makes them; keys that aren't current are brought up to
// date in the lookup worker first (auto-dedupe-index.ts).
import { db } from '../lib/db';
import { sheetBusyWith } from '../lib/sheet-busy';
import { yieldToRequests } from '../lib/slices';
import {
  AUTO_DEDUPE_CHECK_MS, AUTO_DEDUPE_CHECK_ROWS, AUTO_DEDUPE_INLINE_MS, AUTO_DEDUPE_LOOK_ROWS,
  AUTO_DEDUPE_RETRY_MS, AUTO_DEDUPE_ROUND_MS, AUTO_DEDUPE_TICK_MS,
} from '../lib/constants-dedupe';
import {
  autoDedupeOf, queueCheckRows, queueChecks, sheetInTrash, storedKey, type AutoDedupe,
} from '../lib/auto-dedupe/store';
import { drainWithin, keysCurrent } from './auto-dedupe-index';
import { checkAutoDedupeKeys } from './auto-dedupe-purge';
import { AutoDedupeRemoval } from './auto-dedupe-remove';
import { checkRow } from './auto-dedupe-settle';
import { maintainAutoDedupeInBackground } from './lookup-host';
import { bumpDataVersion, sheetHasActiveRun } from './data-plane-shared';

// done: nothing due; later: only checks waiting for a retry; more: go on;
// keys: the keys aren't current; held: another job holds the sheet, or it is
// in the trash (its checks stay queued until it is restored).
type SliceState = 'done' | 'later' | 'more' | 'keys' | 'held';
// retry_at 0: never tried yet (auto-run waits for those: lib/auto-dedupe/store.ts).
interface Range { lo: number; hi: number; retry_at: number }
interface Slice { state: SliceState; removed: number; trashId: number | null }

function checkSlice(sheetId: string, userId: string, ownBusy: boolean): Slice {
  const out: Slice = { state: 'done', removed: 0, trashId: null };
  db.transaction(() => {
    const s = autoDedupeOf(sheetId, userId);
    if (!s) return;
    if (sheetInTrash(sheetId)) { out.state = 'held'; return; }
    if (s.build_cursor !== null) { out.state = 'keys'; return; }
    if (!ownBusy && sheetBusyWith(sheetId)) { out.state = 'held'; return; }
    const now = Date.now();
    // A check that waited on a run waits until no run is going on the sheet:
    // tried every few seconds meanwhile, a big import's would cost a lot for nothing.
    const runs = sheetHasActiveRun(sheetId, userId) ? 1 : 0;
    const ranges = db.prepare(`SELECT lo, hi, retry_at FROM auto_dedupe_checks WHERE dedupe_id = ? AND retry_at <= ?
      AND (retry_at = 0 OR ? = 0) ORDER BY lo LIMIT 50`).all(s.id, now, runs) as Range[];
    if (ranges.length === 0) {
      if (db.prepare('SELECT 1 FROM auto_dedupe_checks WHERE dedupe_id = ? LIMIT 1').get(s.id)) out.state = 'later';
      return;
    }
    if (!drainWithin(s, AUTO_DEDUPE_INLINE_MS)) { out.state = 'keys'; return; }
    const removal = new AutoDedupeRemoval(s, new Set(), true, false);
    const waits = checkRanges(s, ranges, removal);
    if (waits.length > 0) queueCheckRows(s.id, waits, now + AUTO_DEDUPE_RETRY_MS);
    const { trashId } = removal.finish();
    out.removed = removal.removed.length;
    out.trashId = trashId;
    out.state = 'more';
  }).immediate();
  return out;
}

// Checks rows of the ranges in rowid order, within one slice's budget (rows
// looked at, rows removed, time); what's left of each range goes back.
// Returns the rows whose check must wait.
function checkRanges(s: AutoDedupe, ranges: Range[], removal: AutoDedupeRemoval): number[] {
  const rowsIn = db.prepare(`SELECT rowid FROM rows WHERE rowid BETWEEN ? AND ? AND +sheet_id = ? AND +user_id = ?
    ORDER BY rowid LIMIT ?`).pluck();
  const until = Date.now() + AUTO_DEDUPE_CHECK_MS;
  const waits: number[] = [];
  let looked = 0;
  const canRemove = () => AUTO_DEDUPE_CHECK_ROWS - removal.count;
  const spent = () => looked >= AUTO_DEDUPE_LOOK_ROWS || canRemove() <= 0 || Date.now() >= until;
  for (const r of ranges) {
    if (spent()) break;
    const limit = AUTO_DEDUPE_LOOK_ROWS - looked;
    const rids = rowsIn.all(r.lo, r.hi, s.sheet_id, s.user_id, limit) as number[];
    let done = r.lo - 1;
    let cut = rids.length === limit;
    for (const rid of rids) {
      if (spent()) { cut = true; break; }
      const key = storedKey(s.id, rid);
      const result = key === null ? 'done' : checkRow(removal, rid, key, canRemove());
      if (result === 'more') { cut = true; break; }
      if (result === 'wait') waits.push(rid);
      looked++;
      done = rid;
    }
    db.prepare('DELETE FROM auto_dedupe_checks WHERE dedupe_id = ? AND lo = ?').run(s.id, r.lo);
    if (cut && done < r.hi) queueChecks(s.id, done + 1, r.hi, r.retry_at);
    if (cut) break;
  }
  return waits;
}

// left: checks remain; why it stopped: 'time' (the deadline), 'later' (only
// checks waiting on runs), 'held' (another job holds the sheet).
export interface ChecksRun {
  removed: number; trashId: number | null; left: boolean; stopped?: 'time' | 'later' | 'held';
}

// Makes the sheet's waiting checks until none is due or `deadline` (ms since
// epoch). ownBusy: the caller holds the sheet (a CSV import making its own
// rows' checks), so rows already in the sheet may go meanwhile.
export async function runChecks(
  sheetId: string, userId: string, opts: { ownBusy: boolean; deadline: number },
): Promise<ChecksRun> {
  const out: ChecksRun = { removed: 0, trashId: null, left: false };
  // Open tabs reload once the rows are gone, not after every slice.
  const done = (r: ChecksRun): ChecksRun => {
    if (r.removed > 0) db.transaction(() => bumpDataVersion(sheetId, userId))();
    return r;
  };
  for (;;) {
    const r = checkSlice(sheetId, userId, opts.ownBusy);
    out.removed += r.removed;
    out.trashId = r.trashId ?? out.trashId;
    if (r.state === 'done') return done(out);
    if (r.state === 'later' || r.state === 'held') return done({ ...out, left: true, stopped: r.state });
    if (Date.now() >= opts.deadline) return done({ ...out, left: true, stopped: 'time' });
    if (r.state === 'keys') {
      await maintainAutoDedupeInBackground(sheetId, userId, Math.min(AUTO_DEDUPE_ROUND_MS, opts.deadline - Date.now()));
    } else {
      await yieldToRequests();
      db.pragma('wal_checkpoint(PASSIVE)');
      await yieldToRequests();
    }
  }
}

// Keeps the lookup worker on one sheet's keys until they are current (one
// driver per sheet), then makes its waiting checks: a new setting's build.
const driving = new Set<string>();
export function driveAutoDedupe(sheetId: string, userId: string): void {
  if (driving.has(sheetId)) return;
  driving.add(sheetId);
  void (async () => {
    try {
      while (await maintainAutoDedupeInBackground(sheetId, userId, AUTO_DEDUPE_ROUND_MS) !== 'ready') { /* next */ }
      await runChecks(sheetId, userId, { ownBusy: false, deadline: Date.now() + AUTO_DEDUPE_TICK_MS });
    } catch (err) {
      console.error(`Bringing auto-dedupe keys of sheet ${sheetId} up to date failed:`, err);
    } finally {
      driving.delete(sheetId);
    }
  })();
}

// At boot (API process): keys checked against their rows, builds a restart
// cut short go on, then the waiting checks every AUTO_DEDUPE_TICK_MS. Sheets
// in the trash wait: once restored, the rounds (this one, and the lookup
// worker's for keys) pick them up again.
let rounding = false;
export function startAutoDedupeLoop(): void {
  try { checkAutoDedupeKeys(); } catch (err) { console.error('Checking auto-dedupe keys failed:', err); }
  for (const s of db.prepare(`SELECT a.sheet_id, a.user_id FROM auto_dedupe a JOIN sheets s ON s.id = a.sheet_id
    WHERE a.build_cursor IS NOT NULL AND s.trash_id IS NULL`).all() as
    Array<{ sheet_id: string; user_id: string }>) driveAutoDedupe(s.sheet_id, s.user_id);
  setInterval(() => {
    if (rounding) return;
    rounding = true;
    autoDedupeRound()
      .catch(err => console.error('Auto-dedupe checks failed:', err))
      .finally(() => { rounding = false; });
  }, AUTO_DEDUPE_TICK_MS).unref();
}

async function autoDedupeRound(): Promise<void> {
  const due = db.prepare(`SELECT DISTINCT a.sheet_id, a.user_id FROM auto_dedupe a
    JOIN auto_dedupe_checks c ON c.dedupe_id = a.id JOIN sheets s ON s.id = a.sheet_id
    WHERE s.trash_id IS NULL AND c.retry_at <= ?`).all(Date.now()) as Array<{ sheet_id: string; user_id: string }>;
  for (const d of due) {
    if (driving.has(d.sheet_id)) continue;
    const s = autoDedupeOf(d.sheet_id, d.user_id);
    if (!s) continue;
    // Keys with a backlog are brought up to date by a driver, which then checks.
    if (!keysCurrent(s)) { driveAutoDedupe(d.sheet_id, d.user_id); continue; }
    await runChecks(d.sheet_id, d.user_id, { ownBusy: false, deadline: Date.now() + AUTO_DEDUPE_TICK_MS / 4 });
  }
}
