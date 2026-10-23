// Lookup columns as a derived kind (derived-kind.ts): one input, this row's
// source_column, matched against a column of another sheet. Before each slice
// prepare() has that sheet's keys brought up to date in the lookup worker
// (services/lookup-host.ts: an auto-run tick for a moment; a fill for a round,
// then, if a big build or backlog is left, it waits without holding this
// sheet). Inside the slice's write transaction compute() first reads what was
// written there since (a few rows, typically), so every answer matches that
// sheet as it is when the row is written. The pass also waits (derived-fill.ts
// frees this sheet meanwhile) while the other sheet is sorting, importing or
// rewriting a column, and, for a fill, while a run is filling a column it
// reads (not a paused one). A lookup whose other sheet or column is gone
// (`broken`), or a column it reads that starts filling again mid-fill, stops
// the pass with that message.
import { db } from '../lib/db';
import {
  DERIVED_SLICE_CHARS, LOOKUP_CACHE_ENTRIES, LOOKUP_FOLLOW_MAINTAIN_MS, LOOKUP_STEP_ROUND_MS, LOOKUP_STEP_ROWS,
} from '../lib/constants';
import { getSheetColumns } from '../lib/sql-helpers';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { fillingColumns } from '../lib/field-fill-columns';
import { lookupValue } from '../lib/lookup/normalize';
import {
  loadLookupColumn, lookupColumnFor, lookupReturnColumns, type LookupColumnRow,
} from '../lib/lookup-columns';
import type { DerivedCell, DerivedKind, DerivedPass, DerivedUse, DerivedWait } from './derived-kind';
import {
  ensureLookupSource, lookupSourceNearlyReady, lookupSourceOf, lookupSourceState,
} from './lookup-source';
import { drainWithin } from './lookup-maintain';
import { LOOKUP_FILLING, lookupSheetBlocked } from './lookup-blocked';
import { keepMaintaining, maintainLookupInBackground } from './lookup-host';
import { matchContains, matchEquals, type LookupMatches } from './lookup-probe';
import { lookupAnswer, lookupNeed, type LookupAsk } from './lookup-answer';

export { LOOKUP_FILLING };

export function otherSheetName(sheetId: string, userId: string): string | null {
  return (db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck().get(sheetId, userId) as
    string | undefined) ?? null;
}

// The other sheet's columns a lookup reads: the one it matches and the ones it returns.
export const lookupReads = (rec: LookupColumnRow): string[] => [rec.match_column, ...(lookupReturnColumns(rec) ?? [])];

// A column it reads that something is filling now: a run, or a derived column's fill. Not a paused
// run: one can stay paused for days, so a fill doesn't wait for it (a waterfall's lookup step doesn't).
export function readsFilling(rec: LookupColumnRow): { column: string; byRun: boolean } | null {
  const runs = getLockedRunColumns(rec.other_sheet_id, rec.user_id, { paused: false });
  const fills = new Set(fillingColumns(rec.other_sheet_id, rec.user_id));
  for (const c of lookupReads(rec)) {
    if (runs.has(c)) return { column: c, byRun: true };
    if (fills.has(c)) return { column: c, byRun: false };
  }
  return null;
}

export const askOf = (rec: LookupColumnRow): LookupAsk => ({
  otherSheetId: rec.other_sheet_id, userId: rec.user_id, returns: rec.returns,
  returnColumns: lookupReturnColumns(rec), listLimit: rec.list_limit,
});

export function matchesFor(rec: LookupColumnRow, sourceId: number, value: string): LookupMatches {
  const need = lookupNeed(askOf(rec));
  return rec.match_mode === 'equals' ? matchEquals(sourceId, value, need) : matchContains(sourceId, value, need);
}

function openLookupPass(first: LookupColumnRow, use: DerivedUse): DerivedPass {
  let rec = first;
  let failed: string | null = null;
  let wait: DerivedWait | null = null;
  // Matches per value, while the source and its keys stay as they were (a
  // replaced source starts its version again: the id is part of the token).
  const cache = new Map<string, LookupMatches>();
  let cacheToken = '';
  const other = rec.other_sheet_id;
  const name = () => otherSheetName(other, rec.user_id) ?? 'the other sheet';
  const blockedWait = (what: string): DerivedWait => ({
    note: `Waiting for "${name()}" to finish ${what}.`, ready: () => !lookupSheetBlocked(other),
  });

  // The record again (renames there rewrite it), and whether it can go on.
  function check(): boolean {
    wait = null;
    rec = loadLookupColumn(first.id) ?? rec;
    if (rec.broken) { failed = rec.broken; return false; }
    const blocked = lookupSheetBlocked(other);
    if (blocked) { wait = blockedWait(blocked); return false; }
    if (use !== 'fill') return true;
    const filling = readsFilling(rec);
    if (filling?.byRun) {
      wait = {
        note: `Waiting for a run to finish filling "${filling.column}" in "${name()}".`,
        ready: () => !readsFilling(loadLookupColumn(first.id) ?? rec)?.byRun,
      };
      return false;
    }
    if (filling) {
      failed = `"${filling.column}" in "${name()}" started filling again. Look up again once it's done.`;
      return false;
    }
    return true;
  }

  return {
    async prepare() {
      if (!check()) return;
      const have = lookupSourceOf(other, rec.user_id, rec.match_column);
      if (!have || (rec.match_mode === 'contains' && !have.with_text)) {
        db.transaction(() => {
          ensureLookupSource(rec.user_id, other, rec.match_column, rec.match_mode === 'contains');
        }).immediate();
      }
      // In the lookup worker: an auto-run tick for a moment; a fill for a round,
      // and if the keys still aren't current (a big build, a sort's positions,
      // many rows written there), it waits without holding this sheet while
      // the worker goes on.
      if (use !== 'fill') {
        await maintainLookupInBackground(other, rec.user_id, LOOKUP_FOLLOW_MAINTAIN_MS);
        return;
      }
      // The record read again each time: an edit or a rename there may have moved the column.
      const nearly = () => {
        const now = loadLookupColumn(first.id);
        return !now || lookupSourceNearlyReady(other, now.user_id, now.match_column, LOOKUP_STEP_ROWS);
      };
      if (await maintainLookupInBackground(other, rec.user_id, LOOKUP_STEP_ROUND_MS) === 'ready' || nearly()) return;
      keepMaintaining(other, rec.user_id);
      wait = {
        note: `Waiting for "${rec.match_column}" in "${name()}" to be indexed.`,
        ready: () => {
          if (nearly()) return true;
          keepMaintaining(other, rec.user_id);
          return false;
        },
      };
    },
    compute(rows, budgetMs) {
      if (!check()) return [];
      const src = lookupSourceOf(other, rec.user_id, rec.match_column);
      if (!src || (rec.match_mode === 'contains' && !src.with_text)) return [];
      const state = lookupSourceState(src);
      if (state === 'building' || state === 'reordering') return [];
      const until = Date.now() + budgetMs;
      if (state === 'changed' && !drainWithin(other, rec.user_id, budgetMs / 2)) return [];
      const version = db.prepare('SELECT version FROM lookup_sources WHERE id = ?').pluck().get(src.id) as number;
      if (`${src.id}:${version}` !== cacheToken) { cache.clear(); cacheToken = `${src.id}:${version}`; }
      const ask = askOf(rec);
      const columns = ask.returns === 'list' && !ask.returnColumns ? getSheetColumns(other, rec.user_id, false) : [];
      const cells: DerivedCell[] = [];
      let chars = 0;
      for (const inputs of rows) {
        const value = lookupValue(inputs[0]);
        let cell: DerivedCell = { value: '', filled: false };
        if (value) {
          let m = cache.get(value);
          if (!m) {
            m = matchesFor(rec, src.id, value);
            if (cache.size >= LOOKUP_CACHE_ENTRIES) cache.clear();
            cache.set(value, m);
          }
          cell = lookupAnswer(ask, m, columns);
        }
        cells.push(cell);
        chars += cell.value.length;
        if (Date.now() >= until || chars >= DERIVED_SLICE_CHARS) break;
      }
      return cells;
    },
    failure: () => failed,
    failureReason: 'setup',
    waiting: () => wait,
    dispose() { /* nothing held */ },
  };
}

export const lookupKind: DerivedKind<LookupColumnRow> = {
  id: 'lookup',
  table: 'lookup_columns',
  busy: LOOKUP_FILLING,
  noun: 'lookup column',
  load: loadLookupColumn,
  forColumn: lookupColumnFor,
  inputs: rec => [rec.source_column],
  // A rename in the other sheet rewrites match_column / return_columns: the
  // pass reads them again each slice, so it isn't a new setup.
  sameSetup: (a, b) => a.column_name === b.column_name && a.source_column === b.source_column
    && a.other_sheet_id === b.other_sheet_id && a.match_mode === b.match_mode && a.returns === b.returns
    && a.list_limit === b.list_limit,
  async open(rec, use) {
    if (rec.broken) return { error: rec.broken };
    if (!otherSheetName(rec.other_sheet_id, rec.user_id)) return { error: 'The sheet it looks in is gone.' };
    return openLookupPass(rec, use);
  },
  advance(rec, cursor, counts) {
    db.prepare(`UPDATE lookup_columns SET fill_cursor = ?, filled_rows = filled_rows + ?,
      error_rows = error_rows + ?, first_error = COALESCE(first_error, ?), updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND fill_status = 'filling'`)
      .run(cursor, counts.filled, counts.flagged, counts.firstFlag, rec.id, rec.user_id);
  },
};
