// Auto-dedupe's background work on keys (in the lookup worker, with lookups'
// round every LOOKUP_PURGE_TICK_MS: services/lookup-host.ts):
// - a dropped setting's keys, change log and waiting checks
//   (auto_dedupe_purges) are deleted a short step at a time;
// - settings whose keys are being built or have rows to read again are
//   brought up to date (auto-dedupe-index.ts).
// At boot, a few keys of each setting are checked against their rows: keys
// point at rowids, and a VACUUM could renumber them; a setting whose sample
// doesn't match is built again from scratch.
import { db } from '../lib/db';
import { AUTO_DEDUPE_STEP_ROWS } from '../lib/constants-dedupe';
import { autoDedupeKey } from '../lib/auto-dedupe/key';
import type { AutoDedupe } from '../lib/auto-dedupe/store';
import { keysCurrent, maintainAutoDedupeSheet, pruneBuildRows } from './auto-dedupe-index';
import { lookupStep, settleWal } from './lookup-maintain';

const BACKGROUND_MS = 200;

// One step: some rows of the oldest dropped setting, or its journal row once none are left.
function purgeStep(): boolean {
  let more = false;
  lookupStep(() => {
    const id = db.prepare('SELECT dedupe_id FROM auto_dedupe_purges ORDER BY created_at, dedupe_id LIMIT 1')
      .pluck().get() as number | undefined;
    if (id === undefined) return;
    more = true;
    const keys = db.prepare(`DELETE FROM auto_dedupe_keys WHERE dedupe_id = ? AND rid IN
      (SELECT rid FROM auto_dedupe_keys WHERE dedupe_id = ? LIMIT ?)`).run(id, id, AUTO_DEDUPE_STEP_ROWS).changes;
    if (keys > 0) return;
    const dirty = db.prepare(`DELETE FROM auto_dedupe_dirty WHERE dedupe_id = ? AND rid IN
      (SELECT rid FROM auto_dedupe_dirty WHERE dedupe_id = ? LIMIT ?)`).run(id, id, AUTO_DEDUPE_STEP_ROWS).changes;
    if (dirty > 0) return;
    db.prepare('DELETE FROM auto_dedupe_checks WHERE dedupe_id = ?').run(id);
    db.prepare('DELETE FROM auto_dedupe_purges WHERE dedupe_id = ?').run(id);
  });
  return more;
}

// One round of the background work.
export async function autoDedupeBackgroundRound(): Promise<void> {
  const until = Date.now() + BACKGROUND_MS;
  while (Date.now() < until && purgeStep()) await settleWal();
  pruneBuildRows();
  const settings = db.prepare(`SELECT a.* FROM auto_dedupe a JOIN sheets s ON s.id = a.sheet_id
    WHERE s.trash_id IS NULL`).all() as AutoDedupe[];
  for (const s of settings) {
    if (keysCurrent(s)) continue;
    await maintainAutoDedupeSheet(s.sheet_id, s.user_id, Date.now() + BACKGROUND_MS);
  }
}

// A sample of a setting's keys still matches its rows (rows written since
// their keys were read, still in the change log, don't count).
function sampleMatches(s: AutoDedupe): boolean {
  const span = db.prepare('SELECT min(rid) AS lo, max(rid) AS hi FROM auto_dedupe_keys WHERE dedupe_id = ?')
    .get(s.id) as { lo: number | null; hi: number | null };
  if (span.lo === null || span.hi === null) return true;
  const { lo, hi } = span;
  const at = db.prepare('SELECT rid, key FROM auto_dedupe_keys WHERE dedupe_id = ? AND rid >= ? ORDER BY rid LIMIT 1');
  const row = db.prepare('SELECT sheet_id, json_extract(data, ?) AS v FROM rows WHERE rowid = ?');
  const changed = db.prepare('SELECT 1 FROM auto_dedupe_dirty WHERE dedupe_id = ? AND rid = ?');
  for (let k = 0; k < 8; k++) {
    const key = at.get(s.id, Math.floor(lo + (hi - lo) * k / 8)) as
      { rid: number; key: string } | undefined;
    if (!key || changed.get(s.id, key.rid)) continue;
    const r = row.get(s.path, key.rid) as { sheet_id: string; v: unknown } | undefined;
    if (!r || r.sheet_id !== s.sheet_id || autoDedupeKey(s, r.v) !== key.key) return false;
  }
  return true;
}

// At boot (API process): a setting whose keys no longer match its rows is
// made again under a new id (its keys are built from scratch; checks waiting
// name rowids that may mean other rows now, so they go).
export function checkAutoDedupeKeys(): void {
  const settings = db.prepare('SELECT * FROM auto_dedupe WHERE build_cursor IS NULL').all() as AutoDedupe[];
  for (const s of settings) {
    if (sampleMatches(s)) continue;
    console.warn(`Auto-dedupe keys of sheet ${s.sheet_id} no longer match its rows: building them again.`);
    db.transaction(() => {
      db.prepare('DELETE FROM auto_dedupe WHERE id = ?').run(s.id);
      db.prepare(`INSERT INTO auto_dedupe (user_id, sheet_id, column_name, path, match, phone_country, keep,
          removed_rows, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.user_id, s.sheet_id, s.column_name, s.path, s.match, s.phone_country, s.keep, s.removed_rows,
          s.created_at);
    }).immediate();
  }
}
