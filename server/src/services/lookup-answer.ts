// A lookup's cell from its matches (services/lookup-probe.ts): column R of
// the first match ('value'), "Yes"/"No" ('exists'), how many ('count'), or
// the first matches as a JSON list of {column: value} ('list'). The other
// sheet's cells are read when the answer is written, so it shows them as they
// are then; a run's own words (⏳ ❌ ⏭️ ➕) read as empty. What the lookup can't
// answer honestly is a "❌ <why>" cell, never a guess.
import { db } from '../lib/db';
import { CELL_MAX_ENRICHMENT, LOOKUP_CONTAINS_MIN_CHARS, LOOKUP_MAX_MATCHES } from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import type { LookupReturns } from '../lib/lookup-columns';
import type { DerivedCell } from './derived-kind';
import { inputText } from './derived-write';
import type { LookupMatches, LookupNeed } from './lookup-probe';

export interface LookupAsk {
  otherSheetId: string; userId: string; returns: LookupReturns;
  returnColumns: string[] | null;   // 'value': [R]; 'list': chosen, or null = all of the other sheet's
  listLimit: number;
}

export function lookupNeed(a: LookupAsk): LookupNeed {
  if (a.returns === 'exists') return { kind: 'any' };
  if (a.returns === 'count') return { kind: 'count' };
  return { kind: 'first', want: a.returns === 'value' ? 1 : a.listLimit };
}

const fail = (why: string): DerivedCell => ({ value: `❌ ${why}`, filled: false, flag: why });

export const TOO_SHORT = `Contains needs at least ${LOOKUP_CONTAINS_MIN_CHARS} characters`;
export const TOO_MANY = `More than ${LOOKUP_MAX_MATCHES.toLocaleString('en-US')} rows match`;
export const TOO_SLOW = 'Too slow to match by contains: use a longer value';
const TOO_BIG = "The matches don't fit in one cell: return fewer columns or rows";

// `columns`: the other sheet's columns now (a 'list' of all of them).
export function lookupAnswer(a: LookupAsk, m: LookupMatches, columns: string[]): DerivedCell {
  if (m.tooShort) return fail(TOO_SHORT);
  if (m.over) return fail(TOO_MANY);
  if (m.tooSlow) return fail(TOO_SLOW);
  if (a.returns === 'exists') return { value: m.count > 0 ? 'Yes' : 'No', filled: true };
  if (a.returns === 'count') return { value: String(m.count), filled: true };
  if (m.rids.length === 0) return { value: '', filled: false };
  if (a.returns === 'value') {
    const column = a.returnColumns?.[0];
    if (!column) return { value: '', filled: false };
    const v = db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE rowid = ? AND +sheet_id = ? AND +user_id = ?`)
      .pluck().get(jsonPath(column), m.rids[0], a.otherSheetId, a.userId);
    const value = inputText(v);
    return { value, filled: value !== '' };
  }
  const pick = a.returnColumns ?? columns;
  const data = new Map<number, Record<string, unknown>>();
  const ids = JSON.stringify(m.rids);
  if (a.returnColumns) {
    // Just the chosen cells (a row can hold a whole API response in another column).
    const cells = a.returnColumns.map((_, k) => `json_extract(data, ?) AS c${k}`).join(', ');
    for (const r of db.prepare(`SELECT rowid AS rid, ${cells} FROM rows WHERE rowid IN (SELECT value FROM json_each(?))
      AND +sheet_id = ? AND +user_id = ?`).all(...a.returnColumns.map(jsonPath), ids, a.otherSheetId, a.userId) as
      Array<Record<string, unknown>>) {
      data.set(r.rid as number, Object.fromEntries(a.returnColumns.map((c, k) => [c, r[`c${k}`]])));
    }
  } else {
    for (const r of db.prepare(`SELECT rowid AS rid, data FROM rows WHERE rowid IN (SELECT value FROM json_each(?))
      AND +sheet_id = ? AND +user_id = ?`).all(ids, a.otherSheetId, a.userId) as Array<{ rid: number; data: string }>) {
      try { data.set(r.rid, JSON.parse(r.data) as Record<string, unknown>); } catch { /* unreadable: skipped */ }
    }
  }
  const list = m.rids.filter(rid => data.has(rid))
    .map(rid => Object.fromEntries(pick.map(c => [c, inputText(data.get(rid)![c])])));
  const value = JSON.stringify(list);
  if (value.length > CELL_MAX_ENRICHMENT) return fail(TOO_BIG);
  return { value, filled: list.length > 0 };
}
