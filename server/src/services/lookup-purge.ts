// Lookups' background work (in the lookup worker, every LOOKUP_PURGE_TICK_MS:
// services/lookup-host.ts):
// - a dropped source's keys (lookup_purges) are deleted a short step at a
//   time, then the change log of a sheet nothing looks in any more;
// - looked-up sheets are kept up to date (services/lookup-maintain.ts), so a
//   lookup rarely finds much to read again before it matches;
// - a text index no lookup needs any more (its last contains lookup went) is
//   dropped: the column is indexed again without it;
// - waterfall lookup steps' indexes are kept while their newest runs read them
//   (services/waterfall-lookup-sweep.ts), and go once none does.
// At boot, a few keys of each source are checked against their rows: keys
// point at rowids, and a VACUUM could renumber them; a source whose sample
// doesn't match is built again from scratch.
import { db } from '../lib/db';
import { LOOKUP_STEP_ROWS } from '../lib/constants';
import { lookupKey, lookupValue } from '../lib/lookup/normalize';
import { lookupStep, maintainLookupSheet, settleWal } from './lookup-maintain';
import { lookupSourceState, type LookupSource } from './lookup-source';
import { removeText } from './lookup-text';
import { noWaterfallNeeds, PAST_GRACE, releaseWaterfallSources } from './waterfall-lookup-sweep';

const BACKGROUND_MS = 200;

// One step: some keys of the oldest dropped source, or its row once none are left.
function purgeStep(): boolean {
  let more = false;
  lookupStep(() => {
    const p = db.prepare('SELECT * FROM lookup_purges ORDER BY created_at, source_id LIMIT 1').get() as
      { source_id: number; sheet_id: string; with_text: number } | undefined;
    if (!p) return;
    more = true;
    const keys = db.prepare('SELECT rid, key, text FROM lookup_keys WHERE source_id = ? LIMIT ?')
      .all(p.source_id, LOOKUP_STEP_ROWS) as Array<{ rid: number; key: string; text: string | null }>;
    if (keys.length > 0) {
      if (p.with_text) for (const k of keys) removeText(p.source_id, k.rid, k.text ?? k.key);
      db.prepare('DELETE FROM lookup_keys WHERE source_id = ? AND rid IN (SELECT value FROM json_each(?))')
        .run(p.source_id, JSON.stringify(keys.map(k => k.rid)));
      return;
    }
    const looked = db.prepare('SELECT 1 FROM lookup_sources WHERE sheet_id = ? LIMIT 1').get(p.sheet_id);
    if (!looked) {
      const n = db.prepare(`DELETE FROM lookup_dirty WHERE sheet_id = ? AND rid IN
        (SELECT rid FROM lookup_dirty WHERE sheet_id = ? LIMIT ?)`)
        .run(p.sheet_id, p.sheet_id, LOOKUP_STEP_ROWS).changes;
      if (n > 0) return;
    }
    db.prepare('DELETE FROM lookup_purges WHERE source_id = ?').run(p.source_id);
  });
  return more;
}

// One round of the background work.
export async function lookupBackgroundRound(): Promise<void> {
  const until = Date.now() + BACKGROUND_MS;
  while (Date.now() < until && purgeStep()) await settleWal();
  dropUnneededText();
  releaseWaterfallSources();
  const sheets = db.prepare('SELECT DISTINCT sheet_id, user_id FROM lookup_sources').all() as
    Array<{ sheet_id: string; user_id: string }>;
  for (const s of sheets) {
    const sources = db.prepare('SELECT * FROM lookup_sources WHERE sheet_id = ?').all(s.sheet_id) as LookupSource[];
    if (sources.every(src => lookupSourceState(src) === 'ready')) continue;
    await maintainLookupSheet(s.sheet_id, s.user_id, Date.now() + BACKGROUND_MS);
  }
}

// A waterfall's contains step keeps the text index; an equals step, the index without it.
function dropUnneededText(): void {
  const unneeded = db.prepare(`SELECT * FROM lookup_sources s WHERE s.with_text = 1 AND s.${PAST_GRACE}
    AND NOT EXISTS (SELECT 1 FROM lookup_columns c WHERE c.other_sheet_id = s.sheet_id
      AND c.match_column = s.column_name AND c.match_mode = 'contains')`).all() as LookupSource[];
  for (const src of unneeded) {
    if (!noWaterfallNeeds(src, n => n === 'text')) continue;
    const plain = noWaterfallNeeds(src, n => n !== null) ? 0 : 1;
    db.transaction(() => {
      // Again inside the write lock: a contains lookup may have come since.
      const gone = db.prepare(`DELETE FROM lookup_sources WHERE id = ? AND NOT EXISTS (SELECT 1 FROM lookup_columns c
        WHERE c.other_sheet_id = ? AND c.match_column = ? AND c.match_mode = 'contains')`)
        .run(src.id, src.sheet_id, src.column_name).changes;
      if (gone === 0) return;
      db.prepare(`INSERT INTO lookup_sources (user_id, sheet_id, column_name, path, with_text)
        SELECT ?, ?, ?, ?, 0 WHERE ? = 1
          OR EXISTS (SELECT 1 FROM lookup_columns WHERE other_sheet_id = ? AND match_column = ?)`)
        .run(src.user_id, src.sheet_id, src.column_name, src.path, plain, src.sheet_id, src.column_name);
    }).immediate();
  }
}

// A sample of a source's keys still matches its rows (rows written since
// their keys were read, still in the change log, don't count).
function sampleMatches(src: LookupSource): boolean {
  const span = db.prepare('SELECT min(rid) AS lo, max(rid) AS hi FROM lookup_keys WHERE source_id = ?')
    .get(src.id) as { lo: number | null; hi: number | null };
  if (span.lo === null || span.hi === null) return true;
  const at = db.prepare('SELECT rid, key FROM lookup_keys WHERE source_id = ? AND rid >= ? ORDER BY rid LIMIT 1');
  const row = db.prepare('SELECT sheet_id, json_extract(data, ?) AS v FROM rows WHERE rowid = ?');
  const changed = db.prepare('SELECT 1 FROM lookup_dirty WHERE sheet_id = ? AND rid = ?');
  for (let k = 0; k < 8; k++) {
    const key = at.get(src.id, Math.floor(span.lo + (span.hi - span.lo) * k / 8)) as
      { rid: number; key: string } | undefined;
    if (!key || changed.get(src.sheet_id, key.rid)) continue;
    const r = row.get(src.path, key.rid) as { sheet_id: string; v: unknown } | undefined;
    if (!r || r.sheet_id !== src.sheet_id || lookupKey(lookupValue(r.v)) !== key.key) return false;
  }
  return true;
}

export function checkLookupSources(): void {
  const sources = db.prepare('SELECT * FROM lookup_sources WHERE build_cursor IS NULL').all() as LookupSource[];
  for (const src of sources) {
    if (sampleMatches(src)) continue;
    console.warn(`Lookup keys of "${src.column_name}" (sheet ${src.sheet_id}) no longer match its rows: rebuilding.`);
    db.transaction(() => {
      // Again inside the write lock: a contains lookup may have come since.
      const gone = db.prepare(`DELETE FROM lookup_sources WHERE id = ? AND NOT EXISTS (SELECT 1 FROM lookup_columns c
        WHERE c.other_sheet_id = ? AND c.match_column = ? AND c.match_mode = 'contains')`)
        .run(src.id, src.sheet_id, src.column_name).changes;
      if (gone === 0) return;
      db.prepare(`INSERT INTO lookup_sources (user_id, sheet_id, column_name, path, with_text) VALUES (?, ?, ?, ?, ?)`)
        .run(src.user_id, src.sheet_id, src.column_name, src.path, src.with_text);
    }).immediate();
  }
}
