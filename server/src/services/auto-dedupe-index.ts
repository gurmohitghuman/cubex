// Keeping an auto-dedupe sheet's keys (auto_dedupe_keys) equal to its rows,
// in short steps (one transaction of at most AUTO_DEDUPE_STEP_ROWS rows or
// AUTO_DEDUPE_STEP_MS each), as lookups keep theirs (lookup-maintain.ts):
// - build: a new setting reads every row there was when it was made, in
//   storage (rowid) order from build_cursor; rows written meanwhile are in
//   auto_dedupe_dirty too, and both paths write the same keys;
// - drain: rows auto_dedupe_dirty lists (added or written since) are read again.
// Both run in the lookup worker thread on its own connection
// (lookup-host.ts), so neither the steps nor their WAL checkpoints hold the
// API thread; the transaction that adds or edits rows drains the few left
// itself (drainWithin). Keys only: nothing here removes a row.
import { db } from '../lib/db';
import { AUTO_DEDUPE_STEP_MS, AUTO_DEDUPE_STEP_ROWS } from '../lib/constants-dedupe';
import { autoDedupeKey } from '../lib/auto-dedupe/key';
import { autoDedupeById, autoDedupeOf, sheetInTrash, type AutoDedupe } from '../lib/auto-dedupe/store';
import { firstAbove, lookupStep, settleWal } from './lookup-maintain';

const CHUNK = 250;

// The rows' key cells, by rowid (rows of the setting's sheet only).
export function readKeyCells(s: AutoDedupe, rids: readonly number[]): Map<number, unknown> {
  const out = new Map<number, unknown>();
  for (const r of db.prepare(`SELECT rowid AS rid, json_extract(data, ?) AS v FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`)
    .all(s.path, JSON.stringify(rids), s.sheet_id, s.user_id) as Array<{ rid: number; v: unknown }>) {
    out.set(r.rid, r.v);
  }
  return out;
}

// Writes these rows' keys from what they hold now (a row missing from `cells`
// is gone or has no key) and takes them off the change log. Returns each
// row's key before and after.
export function writeKeys(
  s: AutoDedupe, rids: readonly number[], cells: Map<number, unknown>,
): Map<number, { was: string | null; now: string | null }> {
  const out = new Map<number, { was: string | null; now: string | null }>();
  if (rids.length === 0) return out;
  const list = JSON.stringify(rids);
  const old = new Map<number, string>();
  for (const k of db.prepare(`SELECT rid, key FROM auto_dedupe_keys WHERE dedupe_id = ?
    AND rid IN (SELECT value FROM json_each(?))`).all(s.id, list) as Array<{ rid: number; key: string }>) {
    old.set(k.rid, k.key);
  }
  const put = db.prepare(`INSERT INTO auto_dedupe_keys (dedupe_id, rid, key) VALUES (?, ?, ?)
    ON CONFLICT(dedupe_id, rid) DO UPDATE SET key = excluded.key`);
  const drop = db.prepare('DELETE FROM auto_dedupe_keys WHERE dedupe_id = ? AND rid = ?');
  for (const rid of rids) {
    const was = old.get(rid) ?? null;
    const now = cells.has(rid) ? autoDedupeKey(s, cells.get(rid)) : null;
    if (now !== was) {
      if (now === null) drop.run(s.id, rid); else put.run(s.id, rid, now);
    }
    out.set(rid, { was, now });
  }
  db.prepare('DELETE FROM auto_dedupe_dirty WHERE dedupe_id = ? AND rid IN (SELECT value FROM json_each(?))')
    .run(s.id, list);
  return out;
}

const keysFor = (s: AutoDedupe, rids: number[]): void => { writeKeys(s, rids, readKeyCells(s, rids)); };

// Inside a step's transaction: the setting went, or its key column was
// renamed since `s` was read (a rename's first slices may have moved the rows'
// cells already: read under the old name they would have no key, and lose it
// for good). The step stops; the next one reads the setting again.
const changedSince = (s: AutoDedupe): boolean => autoDedupeById(s.id)?.path !== s.path;

// Rows built per setting: the rowids the sheet had when its build started
// (in memory while it builds; a restart reads them again). One statement
// reads them, so rows moving meanwhile can't be seen twice or missed.
const buildRows = new Map<number, Float64Array>();

// One step of a build (exported for tests): true while rows are left.
export function buildStep(s: AutoDedupe): boolean {
  let ids = buildRows.get(s.id);
  if (!ids) {
    const all = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
      .all(s.sheet_id, s.user_id) as number[];
    ids = Float64Array.from(all).sort();
    buildRows.set(s.id, ids);
  }
  const rows = ids;
  let finished = false;
  let done = false;
  let moved = false;
  try {
    lookupStep(() => {
      const cursor = db.prepare('SELECT build_cursor FROM auto_dedupe WHERE id = ?').pluck().get(s.id) as
        number | null | undefined;
      if (cursor === null || cursor === undefined) { done = true; return; }
      if (changedSince(s)) { moved = true; return; }
      let at = firstAbove(rows, cursor);
      const until = Date.now() + AUTO_DEDUPE_STEP_MS;
      for (let n = 0; at < rows.length && n < AUTO_DEDUPE_STEP_ROWS && Date.now() < until; n += CHUNK) {
        const rids = Array.from(rows.subarray(at, Math.min(rows.length, at + CHUNK)));
        keysFor(s, rids);
        at += rids.length;
      }
      finished = at >= rows.length;
      // Built: the cursor stays on the last row until countShared ends it with the count (one write).
      db.prepare('UPDATE auto_dedupe SET build_cursor = ? WHERE id = ?').run(at > 0 ? rows[at - 1] : cursor, s.id);
    });
  } catch (err) {
    buildRows.delete(s.id);
    throw err;
  }
  if (done) { buildRows.delete(s.id); return false; }
  if (moved) return true;
  if (finished) {
    buildRows.delete(s.id);
    countShared(s.id);
  }
  return !finished;
}

// Once every row's key is in: how many rows already shared a key with an
// older row (left as they were; Remove duplicates cleans them up once),
// counted outside a transaction (a read: writers go on), then written with
// the end of the build, so a setting that reads as built has its count.
function countShared(id: number): void {
  const n = db.prepare('SELECT COUNT(*) - COUNT(DISTINCT key) FROM auto_dedupe_keys WHERE dedupe_id = ?').pluck()
    .get(id) as number;
  db.prepare('UPDATE auto_dedupe SET build_cursor = NULL, shared_rows = ? WHERE id = ?').run(n, id);
}

const takeDirty = () => db.prepare('SELECT rid FROM auto_dedupe_dirty WHERE dedupe_id = ? ORDER BY rid LIMIT ?')
  .pluck();

// One step of a drain (exported for tests): true while rows are left.
export function drainStep(s: AutoDedupe): boolean {
  let more = false;
  lookupStep(() => {
    if (changedSince(s)) { more = true; return; }
    const take = takeDirty();
    const until = Date.now() + AUTO_DEDUPE_STEP_MS;
    for (let n = 0; n < AUTO_DEDUPE_STEP_ROWS && Date.now() < until; n += CHUNK) {
      const rids = take.all(s.id, CHUNK) as number[];
      keysFor(s, rids);
      more = rids.length === CHUNK;
      if (!more) break;
    }
  });
  return more;
}

// Whether the keys are current: built, and no row written since its key was read.
export function keysCurrent(s: AutoDedupe): boolean {
  return s.build_cursor === null && !db.prepare('SELECT 1 FROM auto_dedupe_dirty WHERE dedupe_id = ? LIMIT 1')
    .get(s.id);
}

// Brings one sheet's keys up to date, a step at a time, until `deadline` (ms
// since epoch): 'ready' when nothing is left (or the setting is gone, or the
// sheet is in the trash: its keys are brought up to date once it is restored).
export async function maintainAutoDedupeSheet(
  sheetId: string, userId: string, deadline: number,
): Promise<'ready' | 'later'> {
  for (;;) {
    const s = autoDedupeOf(sheetId, userId);
    if (!s || sheetInTrash(sheetId, userId)) return 'ready';
    const more = s.build_cursor !== null ? buildStep(s) || drainStep(s) : drainStep(s);
    await settleWal();
    const now = autoDedupeById(s.id);
    if (!more && (!now || keysCurrent(now))) return 'ready';
    if (Date.now() >= deadline) return 'later';
  }
}

// Inside the transaction that adds or edits rows: the rows written since
// their keys were read, but not `own` (the caller reads those itself), as
// long as it fits `budgetMs`. True when none is left.
export function drainWithin(s: AutoDedupe, budgetMs: number, own: readonly number[] = []): boolean {
  const until = Date.now() + budgetMs;
  const take = db.prepare(`SELECT rid FROM auto_dedupe_dirty WHERE dedupe_id = ?
    AND rid NOT IN (SELECT value FROM json_each(?)) LIMIT ?`).pluck();
  const mine = JSON.stringify(own);
  for (;;) {
    const rids = take.all(s.id, mine, CHUNK) as number[];
    if (rids.length === 0) return true;
    if (Date.now() >= until) return false;
    keysFor(s, rids);
  }
}

// A worker thread let go of builds it no longer runs (the setting went).
export function pruneBuildRows(): void {
  if (buildRows.size === 0) return;
  const building = new Set(db.prepare('SELECT id FROM auto_dedupe WHERE build_cursor IS NOT NULL').pluck()
    .all() as number[]);
  for (const id of buildRows.keys()) if (!building.has(id)) buildRows.delete(id);
}
