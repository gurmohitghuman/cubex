// A lookup's fill and the columns it reads in the other sheet that something
// is filling. A run (not a paused one) it waits for, then goes on where it
// was. A fill there (a clean, formula or lookup column, or answers added as a
// column) it waits for too, then looks every row up again from the first if
// it had written some, so every row comes from one version of those values
// (lookups are free: that costs only time). The wait is durable: the record
// stays filling, and a restart resumes the fill, which waits again or goes on.
// It goes on as soon as a fill there ends (derived-fill-wait.ts wakeOn).
// Lookups that would wait for each other in a loop (each reads a column the
// next one fills, back to the first) never could: they all fail, naming each
// column and sheet, and start refuses to close such a loop.
import { db } from '../lib/db';
import { LOOKUP_FILL_WAIT_POLL_MS } from '../lib/constants';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { fillingColumns } from '../lib/field-fill-columns';
import { loadLookupColumn, lookupReturnColumns, type LookupColumnRow } from '../lib/lookup-columns';
import type { DerivedWait } from './derived-kind';
import { wakeFillsWaitingOn } from './derived-fill-wait';

// The other sheet's columns a lookup reads: the one it matches and the ones it returns.
export const lookupReads = (rec: Pick<LookupColumnRow, 'match_column' | 'return_columns'>): string[] =>
  [rec.match_column, ...(lookupReturnColumns(rec) ?? [])];

// A column it reads that something is filling now: a run, or a fill. Not a paused run: one can stay
// paused for days, so a fill doesn't wait for it (a waterfall's lookup step doesn't).
export function readsFilling(rec: LookupColumnRow): { column: string; byRun: boolean } | null {
  const runs = getLockedRunColumns(rec.other_sheet_id, rec.user_id, { paused: false });
  const fills = new Set(fillingColumns(rec.other_sheet_id, rec.user_id));
  for (const c of lookupReads(rec)) {
    if (runs.has(c)) return { column: c, byRun: true };
    if (fills.has(c)) return { column: c, byRun: false };
  }
  return null;
}

// A lookup as the loop check sees it (start: id null for one not saved yet).
export interface LookupNode {
  id: string | null; userId: string; sheetId: string; column: string; otherSheetId: string; reads: string[];
}
export const nodeOf = (r: LookupColumnRow): LookupNode => ({
  id: r.id, userId: r.user_id, sheetId: r.sheet_id, column: r.column_name, otherSheetId: r.other_sheet_id,
  reads: lookupReads(r),
});

// Lookups filling one of these columns of a sheet (a broken one stops at its next look: it isn't a wait).
const fillingLookups = (sheetId: string, userId: string, columns: string[]): LookupColumnRow[] =>
  db.prepare(`SELECT * FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
    AND broken IS NULL AND column_name IN (SELECT value FROM json_each(?)) ORDER BY created_at`)
    .all(sheetId, userId, JSON.stringify(columns)) as LookupColumnRow[];

// The filling lookups `from` waits for, each waiting for the next, the last for `from`: the loop after
// `from`, or null. Only a lookup waits for a fill, so only lookups lead on.
export function lookupWaitLoop(from: LookupNode): LookupColumnRow[] | null {
  const seen = new Set<string>(from.id ? [from.id] : []);
  const walk = (at: LookupNode, path: LookupColumnRow[]): LookupColumnRow[] | null => {
    for (const next of fillingLookups(at.otherSheetId, at.userId, at.reads)) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      const loop = [...path, next];
      if (next.other_sheet_id === from.sheetId && lookupReads(next).includes(from.column)) return loop;
      const found = walk(nodeOf(next), loop);
      if (found) return found;
    }
    return null;
  };
  return walk(from, []);
}

type Named = { column: string; sheet: string };
const at = (n: Named) => `"${n.column}" in "${n.sheet}"`;
const sheetName = (sheetId: string, userId: string): string =>
  (db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck().get(sheetId, userId) as
    string | undefined) ?? 'a deleted sheet';

// '"A" in "S1" waits for "B" in "S2" to finish filling, "B" in "S2" for "C" in "S3", and "C" in "S3" for "A" in "S1"'
function loopWords(loop: Named[], verb: string): string {
  const first = `${at(loop[0])} ${verb} for ${at(loop[1])} to finish filling`;
  if (loop.length === 2) return `${first}, and ${at(loop[1])} waits for ${at(loop[0])}`;
  const rest = loop.slice(1).map((n, i) => `${at(n)} for ${at(loop[(i + 2) % loop.length])}`);
  return `${first}, ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`;
}

// Start refuses a lookup that would close a loop with lookups filling now.
export function startLoopMessage(from: LookupNode, others: LookupColumnRow[]): string {
  const loop = [{ column: from.column, sheet: sheetName(from.sheetId, from.userId) },
    ...others.map(r => ({ column: r.column_name, sheet: sheetName(r.sheet_id, r.user_id) }))];
  return `${loopWords(loop, 'would wait')}: ${loop.length === 2 ? 'neither' : 'none of them'} could finish. `
    + `Look up once ${at(loop[1])} is done.`;
}

// In a fill's look (inside a slice's transaction, or before one): the other lookups of its loop fail,
// each told the loop from itself, and their sheets' open tabs reload. Returns rec's own message: its
// fill ends failed with it (derived-fill.ts).
export function failLookupLoop(rec: LookupColumnRow, others: LookupColumnRow[]): string {
  const loop = [rec, ...others].map(r => ({
    id: r.id, userId: r.user_id, sheetId: r.sheet_id, column: r.column_name, sheet: sheetName(r.sheet_id, r.user_id),
  }));
  const told = (i: number) => `${loopWords([...loop.slice(i), ...loop.slice(0, i)], 'waits')}: `
    + `${loop.length === 2 ? 'neither' : 'none of them'} can finish. Look them up again one at a time.`;
  const fail = db.prepare(`UPDATE lookup_columns SET fill_status = 'failed', error_message = ?,
    updated_at = datetime('now') WHERE id = ? AND fill_status = 'filling'`);
  const reload = db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`);
  const ended: string[] = [];
  db.transaction(() => {
    loop.forEach((l, i) => {
      if (i > 0 && fail.run(told(i), l.id).changes > 0) { reload.run(l.sheetId, l.userId); ended.push(l.sheetId); }
    });
  }).immediate();
  setImmediate(() => { for (const s of ended) wakeFillsWaitingOn(s); });
  return told(0);
}

// Rows it wrote before a column it reads started filling came from the values before: once it goes
// on, the fill looks every row up again from the first (the cursor is the record's, so a restart does too).
export function startOver(rec: LookupColumnRow): void {
  db.prepare(`UPDATE lookup_columns SET fill_cursor = 0, filled_rows = 0, error_rows = 0, first_error = NULL,
      updated_at = datetime('now')
    WHERE id = ? AND fill_status = 'filling' AND fill_cursor > 0`).run(rec.id);
}

// The wait for a fill of a column it reads. Ready once no fill holds what it reads (a run there it
// then waits for), or a loop closed meanwhile, or the record changed under it: the fill looks again.
export function fillWait(rec: LookupColumnRow, column: string, otherName: string): DerivedWait {
  return {
    note: `Waits for "${column}" in "${otherName}" to finish filling.`,
    wakeOn: rec.other_sheet_id,
    pollMs: LOOKUP_FILL_WAIT_POLL_MS,
    ready: () => {
      const now = loadLookupColumn(rec.id);
      if (!now || now.fill_status !== 'filling' || now.broken || now.other_sheet_id !== rec.other_sheet_id) {
        return true;
      }
      const filling = readsFilling(now);
      return !filling || filling.byRun || lookupWaitLoop(nodeOf(now)) !== null;
    },
  };
}
