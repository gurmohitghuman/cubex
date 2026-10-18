// Keeping a looked-up sheet's keys (lookup_keys, and lookup_text for contains)
// equal to its rows, in short steps (one transaction of at most
// LOOKUP_STEP_ROWS rows or LOOKUP_STEP_MS each):
// - build: a new source reads every row there was when it was made, in
//   storage (rowid) order from build_cursor; rows written meanwhile are in
//   lookup_dirty too, and both paths write the same keys;
// - drain: rows lookup_dirty lists (written, added or deleted since) are read
//   again;
// - reposition: after a sort (order_dirty), every key's row position is read
//   again, in key order.
// Every step is idempotent and journaled in its own tables, so a restart goes
// on where it stopped. It runs in the lookup worker thread, on its own
// connection (services/lookup-host.ts): neither its steps nor the WAL
// checkpoints they need hold the API thread. Keys go into their index in
// random order, so a step dirties about one page per row: each commits without
// the automatic checkpoint, and a PASSIVE one follows on its own. Steps may run
// while the sheet sorts, imports or renames a column: whatever moves meanwhile
// is logged again (the triggers) and read again, and lookups don't match until
// then (services/lookup-blocked.ts).
// Over 200 lines: the three steps share one key writer; split, they could drift.
import { db } from '../lib/db';
import { LOOKUP_STEP_MS, LOOKUP_STEP_ROWS } from '../lib/constants';
import { yieldToRequests } from '../lib/slices';
import { lookupKey, lookupText, lookupValue } from '../lib/lookup/normalize';
import { lookupSourceState, sheetLookupSources, type LookupSource } from './lookup-source';
import { addText, removeText } from './lookup-text';

// A step's transaction, committed without the automatic checkpoint (each
// step dirties about one index page per row, enough to trigger it): settleWal
// copies the WAL back in a turn of its own after the step.
export function lookupStep(work: () => void): void {
  const auto = db.pragma('wal_autocheckpoint', { simple: true }) as number;
  db.pragma('wal_autocheckpoint = 0');
  try {
    db.transaction(work).immediate();
  } finally {
    db.pragma(`wal_autocheckpoint = ${auto}`);
  }
}

interface Current { i: number; v: unknown }
interface Kept { rid: number; row_index: number; key: string; text: string | null }

// Writes one source's keys for these rows from what they hold now (`current`:
// a row missing from it is gone, or holds nothing to match): only what
// changed. True when a key or position changed.
function applyRows(src: LookupSource, ridsIn: number[], current: Map<number, Current>): boolean {
  const rids = [...new Set(ridsIn)];
  const old = new Map<number, Kept>();
  for (const k of db.prepare(`SELECT rid, row_index, key, text FROM lookup_keys
    WHERE source_id = ? AND rid IN (SELECT value FROM json_each(?))`).all(src.id, JSON.stringify(rids)) as Kept[]) {
    old.set(k.rid, k);
  }
  const insert = db.prepare('INSERT INTO lookup_keys (source_id, rid, row_index, key, text) VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE lookup_keys SET row_index = ?, key = ?, text = ? WHERE source_id = ? AND rid = ?');
  const remove = db.prepare('DELETE FROM lookup_keys WHERE source_id = ? AND rid = ?');
  let changed = false;
  for (const rid of rids) {
    const cur = current.get(rid);
    const o = old.get(rid);
    const value = cur ? lookupValue(cur.v) : '';
    if (!value) {
      if (o) {
        remove.run(src.id, rid);
        if (src.with_text) removeText(src.id, rid, o.text ?? o.key);
        changed = true;
      }
      continue;
    }
    const key = lookupKey(value);
    const text = src.with_text ? lookupText(value) : null;
    const kept = text !== null && text !== key ? text : null;
    if (o && o.key === key && o.row_index === cur!.i && o.text === kept) continue;
    if (o) update.run(cur!.i, key, kept, src.id, rid);
    else insert.run(src.id, rid, cur!.i, key, kept);
    if (text !== null && (!o || (o.text ?? o.key) !== text)) {
      if (o) removeText(src.id, rid, o.text ?? o.key);
      addText(src.id, rid, text);
    }
    changed = true;
  }
  return changed;
}

// The rows' positions and values of one column, by rowid (those of the sheet only).
function readRows(src: LookupSource, rids: number[]): Map<number, Current> {
  const out = new Map<number, Current>();
  for (const r of db.prepare(`SELECT rowid AS rid, row_index AS i, json_extract(data, ?) AS v FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`)
    .all(src.path, JSON.stringify(rids), src.sheet_id, src.user_id) as Array<{ rid: number } & Current>) {
    out.set(r.rid, r);
  }
  return out;
}

const bumpVersion = (src: LookupSource): void => {
  db.prepare('UPDATE lookup_sources SET version = version + 1 WHERE id = ?').run(src.id);
};

// Chunks of a step: as many as fit LOOKUP_STEP_MS (at least one).
const CHUNK = 250;

// Rows built per source: the rowids the sheet had when the build started
// (kept in memory while it builds; a restart reads them again). One statement
// reads them, so a sort moving rows meanwhile can't make it see a row twice or
// miss one (a page at a time by row position could); it runs in the worker.
const buildRows = new Map<number, Float64Array>();

function snapshotRowIds(sheetId: string, userId: string): Float64Array {
  const ids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
    .all(sheetId, userId) as number[];
  return Float64Array.from(new Set(ids)).sort();
}

// A job thread that built keys for a waterfall run lets every snapshot go when
// the run ends (a later build reads its rows again).
export function forgetBuildRows(): void {
  buildRows.clear();
}

// Snapshots of sources no longer building (dropped, or replaced) are let go.
function pruneBuildRows(): void {
  if (buildRows.size === 0) return;
  const building = new Set(db.prepare('SELECT id FROM lookup_sources WHERE build_cursor IS NOT NULL').pluck()
    .all() as number[]);
  for (const id of buildRows.keys()) if (!building.has(id)) buildRows.delete(id);
}

function buildStep(src: LookupSource): boolean {
  try {
    return buildSlice(src);
  } catch (err) {
    buildRows.delete(src.id);
    throw err;
  }
}

function buildSlice(src: LookupSource): boolean {
  let ids = buildRows.get(src.id);
  if (!ids) {
    ids = snapshotRowIds(src.sheet_id, src.user_id);
    buildRows.set(src.id, ids);
  }
  const all = ids;
  let more = false;
  lookupStep(() => {
    const cursor = db.prepare('SELECT build_cursor FROM lookup_sources WHERE id = ?').pluck().get(src.id) as
      number | null | undefined;
    if (cursor === null || cursor === undefined) return;
    let at = firstAbove(all, cursor);
    const until = Date.now() + LOOKUP_STEP_MS;
    let changed = false;
    for (let done = 0; at < all.length && done < LOOKUP_STEP_ROWS && Date.now() < until; done += CHUNK) {
      const rids = Array.from(all.subarray(at, Math.min(all.length, at + CHUNK)));
      changed = applyRows(src, rids, readRows(src, rids)) || changed;
      at += rids.length;
    }
    if (changed) bumpVersion(src);
    const finished = at >= all.length;
    db.prepare('UPDATE lookup_sources SET build_cursor = ? WHERE id = ?')
      .run(finished ? null : all[at - 1], src.id);
    more = !finished;
  });
  if (!more) buildRows.delete(src.id);
  return more;
}

// The index of the first rowid above `cursor` (rowIds ascending).
function firstAbove(rowIds: Float64Array, cursor: number): number {
  let lo = 0, hi = rowIds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowIds[mid] <= cursor) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Rows of the sheet written since their keys were read, for every source on it.
function drainStep(sheetId: string, userId: string): boolean {
  let more = false;
  lookupStep(() => {
    const sources = sheetLookupSources(sheetId, userId);
    const until = Date.now() + LOOKUP_STEP_MS;
    const take = db.prepare('SELECT rid FROM lookup_dirty WHERE sheet_id = ? AND user_id = ? LIMIT ?').pluck();
    const done = db.prepare(`DELETE FROM lookup_dirty WHERE sheet_id = ? AND user_id = ?
      AND rid IN (SELECT value FROM json_each(?))`);
    const changed = new Set<LookupSource>();
    for (let n = 0; n < LOOKUP_STEP_ROWS && Date.now() < until; n += CHUNK) {
      const rids = take.all(sheetId, userId, CHUNK) as number[];
      for (const src of sources) if (applyRows(src, rids, readRows(src, rids))) changed.add(src);
      done.run(sheetId, userId, JSON.stringify(rids));
      more = rids.length === CHUNK;
      if (!more) break;
    }
    for (const src of changed) bumpVersion(src);
  });
  return more;
}

// After a sort: the keys' row positions, read again in key order.
function repositionStep(src: LookupSource): boolean {
  let more = false;
  lookupStep(() => {
    const now = db.prepare('SELECT order_dirty, order_cursor FROM lookup_sources WHERE id = ?').get(src.id) as
      { order_dirty: number; order_cursor: number | null } | undefined;
    if (!now || (!now.order_dirty && now.order_cursor === null)) return;
    let cursor = now.order_cursor ?? 0;
    if (now.order_cursor === null) {
      // A sort that lands meanwhile sets order_dirty again: one more pass.
      db.prepare('UPDATE lookup_sources SET order_dirty = 0, order_cursor = 0 WHERE id = ?').run(src.id);
    }
    const next = db.prepare('SELECT rid FROM lookup_keys WHERE source_id = ? AND rid > ? ORDER BY rid LIMIT ?').pluck();
    const move = db.prepare(`UPDATE lookup_keys SET row_index = r.row_index FROM rows r
      WHERE lookup_keys.source_id = ? AND lookup_keys.rid IN (SELECT value FROM json_each(?))
        AND r.rowid = lookup_keys.rid AND lookup_keys.row_index <> r.row_index`);
    const until = Date.now() + LOOKUP_STEP_MS;
    let moved = 0;
    for (let n = 0; n < LOOKUP_STEP_ROWS && Date.now() < until; n += CHUNK * 4) {
      const rids = next.all(src.id, cursor, CHUNK * 4) as number[];
      if (rids.length === 0) { cursor = -1; break; }
      moved += move.run(src.id, JSON.stringify(rids)).changes;
      cursor = rids[rids.length - 1];
    }
    if (moved > 0) bumpVersion(src);
    db.prepare('UPDATE lookup_sources SET order_cursor = ? WHERE id = ?').run(cursor === -1 ? null : cursor, src.id);
    more = cursor !== -1;
  });
  return more;
}

// One step of whatever the sheet's sources still need: a build or reposition
// step and a drain step take turns, so rows written meanwhile don't pile up
// behind a long build (an equals lookup on the same sheet would wait for
// them). False once nothing is left.
const lastWasBuild = new Map<string, boolean>();

function step(sheetId: string, userId: string): boolean {
  const pending = sheetLookupSources(sheetId, userId).find(src => {
    const state = lookupSourceState(src);
    return state === 'building' || state === 'reordering';
  });
  const dirty = !!db.prepare('SELECT 1 FROM lookup_dirty WHERE sheet_id = ? AND user_id = ? LIMIT 1')
    .get(sheetId, userId);
  if (pending && !(dirty && lastWasBuild.get(sheetId))) {
    lastWasBuild.set(sheetId, true);
    if (lookupSourceState(pending) === 'building') buildStep(pending); else repositionStep(pending);
    return true;
  }
  lastWasBuild.set(sheetId, false);
  return drainStep(sheetId, userId) || !!pending;
}

// Brings the sheet's sources up to date, a step at a time, until `deadline`
// (ms since epoch). 'ready': nothing left; 'later': time ran out.
export async function maintainLookupSheet(
  sheetId: string, userId: string, deadline: number,
): Promise<'ready' | 'later'> {
  pruneBuildRows();
  for (;;) {
    const more = step(sheetId, userId);
    await settleWal();
    if (!more && sheetLookupSources(sheetId, userId).every(s => lookupSourceState(s) === 'ready')) return 'ready';
    if (Date.now() >= deadline) return 'later';
  }
}

// After a step: the WAL copied back while it is small.
export async function settleWal(): Promise<void> {
  await yieldToRequests();
  db.pragma('wal_checkpoint(PASSIVE)');
  await yieldToRequests();
}

// Inside the transaction that matches: drain what's left, as long as it fits
// `budgetMs` (a few rows written a moment ago, typically). True when nothing is.
export function drainWithin(sheetId: string, userId: string, budgetMs: number): boolean {
  const until = Date.now() + budgetMs;
  const take = db.prepare('SELECT rid FROM lookup_dirty WHERE sheet_id = ? AND user_id = ? LIMIT ?').pluck();
  const done = db.prepare(`DELETE FROM lookup_dirty WHERE sheet_id = ? AND user_id = ?
    AND rid IN (SELECT value FROM json_each(?))`);
  const sources = sheetLookupSources(sheetId, userId);
  for (;;) {
    const rids = take.all(sheetId, userId, CHUNK) as number[];
    if (rids.length === 0) return true;
    if (Date.now() >= until) return false;
    for (const src of sources) if (applyRows(src, rids, readRows(src, rids))) bumpVersion(src);
    done.run(sheetId, userId, JSON.stringify(rids));
  }
}
