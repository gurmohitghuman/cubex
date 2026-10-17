// Looked-up columns (lookup_sources, migration 031): one per column of a sheet
// that lookups match against, shared by every lookup reading it. Creating one
// turns the triggers on for its sheet at once, in the same transaction that
// saves the lookup, so no write is missed while its keys are built
// (services/lookup-maintain.ts). It goes once no lookup reads it: on a lookup
// deleted (trigger lookup_column_delete), or edited onto another column
// (releaseLookupSource); its keys are then deleted in slices
// (services/lookup-purge.ts).
import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-rows';

export interface LookupSource {
  id: number; user_id: string; sheet_id: string; column_name: string; path: string; with_text: number;
  build_cursor: number | null; order_dirty: number; order_cursor: number | null; version: number;
}

export function lookupSourceOf(sheetId: string, userId: string, column: string): LookupSource | undefined {
  return db.prepare('SELECT * FROM lookup_sources WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .get(sheetId, userId, column) as LookupSource | undefined;
}

export function sheetLookupSources(sheetId: string, userId: string): LookupSource[] {
  return db.prepare('SELECT * FROM lookup_sources WHERE sheet_id = ? AND user_id = ? ORDER BY id')
    .all(sheetId, userId) as LookupSource[];
}

// Inside the transaction that saves a lookup: the source it reads, made if
// missing. A contains lookup needs the text index: a source without it is
// replaced by one with it (the old one's keys go in slices).
export function ensureLookupSource(userId: string, sheetId: string, column: string, withText: boolean): LookupSource {
  const have = lookupSourceOf(sheetId, userId, column);
  if (have && (have.with_text === 1 || !withText)) return have;
  if (have) db.prepare('DELETE FROM lookup_sources WHERE id = ?').run(have.id);
  return db.prepare(`INSERT INTO lookup_sources (user_id, sheet_id, column_name, path, with_text)
    VALUES (?, ?, ?, ?, ?) RETURNING *`)
    .get(userId, sheetId, column, jsonPath(column), withText ? 1 : 0) as LookupSource;
}

// After an edit moved a lookup off a column: its source goes if no lookup reads it.
export function releaseLookupSource(userId: string, sheetId: string, column: string): void {
  db.prepare(`DELETE FROM lookup_sources WHERE sheet_id = ? AND user_id = ? AND column_name = ?
    AND NOT EXISTS (SELECT 1 FROM lookup_columns WHERE other_sheet_id = ? AND match_column = ?)`)
    .run(sheetId, userId, column, sheetId, column);
}

// What still stands between a source and an exact answer (read inside the
// transaction that matches): its keys being built, row positions to read again
// after a sort, rows of its sheet written since their keys were read, or nothing.
export type SourceState = 'building' | 'reordering' | 'changed' | 'ready';

// Close enough to match now: built, positions current, and at most `backlog`
// rows written there since (the matching transaction reads those itself).
export function lookupSourceNearlyReady(sheetId: string, userId: string, column: string, backlog: number): boolean {
  const src = lookupSourceOf(sheetId, userId, column);
  if (!src) return false;
  const state = lookupSourceState(src);
  if (state === 'ready') return true;
  if (state !== 'changed') return false;
  return (db.prepare('SELECT count(*) FROM (SELECT 1 FROM lookup_dirty WHERE sheet_id = ? LIMIT ?)').pluck()
    .get(sheetId, backlog + 1) as number) <= backlog;
}

export function lookupSourceState(src: LookupSource): SourceState {
  const now = db.prepare('SELECT build_cursor, order_dirty, order_cursor FROM lookup_sources WHERE id = ?')
    .get(src.id) as Pick<LookupSource, 'build_cursor' | 'order_dirty' | 'order_cursor'> | undefined;
  if (!now || now.build_cursor !== null) return 'building';
  if (now.order_dirty || now.order_cursor !== null) return 'reordering';
  const changed = db.prepare('SELECT 1 FROM lookup_dirty WHERE sheet_id = ? LIMIT 1').get(src.sheet_id);
  return changed ? 'changed' : 'ready';
}
