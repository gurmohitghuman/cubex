// The count on the company sheet for Open roles (services/open-roles.ts): a lookup counting each company's roles in
// the Open roles sheet, made after a run's start (a lookup's fill holds the sheet, which the start's setup of its rows
// holds first) and looked up again once the run's roles are in, as a lookup doesn't follow the sheet it looks in.
// Neither keeps the start waiting: a run start answers at once (CLAUDE.md), so what the sheet can't take yet is done
// in the background as soon as it is free.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { writeColumnDescription } from '../lib/column-descriptions';
import { HIRING_CHECK_POLL_MS, OPEN_ROLES_LOOKUPS_LATER_MS } from '../lib/constants';
import { sheetFreeWithin } from '../lib/sheet-busy';
import { OPEN_ROLES, OPEN_ROLES_WORDS, ROLE_COLUMNS } from '../lib/hiring/names';
import type { OpenRolesOptions } from '../lib/hiring/open-roles-input';
import { lookupInputOf, startLookupColumn } from './lookup-column';
import { searchState } from './hiring-check-watch';
import type { LookupColumnRow } from '../lib/lookup-columns';

// A name not taken in `taken`: base, else "base 2", "base 3"...
export function freeName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map(t => t.toLowerCase()));
  let name = base;
  for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

export interface LookupsNow { lookups: string[]; left: string | null }

// The count on the company sheet, found by what it looks up whatever its name, made once; one that reads another
// website column than this run's is pointed at this one (the roles' Domain copies it). It waits for the sheet first,
// at most waitMs (the run's start, or another fill, holds it), and looks again then: another call may have made it.
async function ensureLookups(userId: string, sheetId: string, o: OpenRolesOptions, rolesSheetId: string,
  waitMs: number): Promise<LookupsNow> {
  const ours = () => (db.prepare(`SELECT column_name, source_column FROM lookup_columns WHERE sheet_id = ?
    AND user_id = ? AND other_sheet_id = ? AND match_column = ? AND returns = 'count'`)
    .all(sheetId, userId, rolesSheetId, ROLE_COLUMNS.domain) as Array<{ column_name: string; source_column: string }>)
    .find(h => getSheetColumns(sheetId, userId).includes(h.column_name));
  const ready = (f: ReturnType<typeof ours>) => !!f && f.source_column === o.websiteColumn;
  let found = ours();
  if (ready(found)) return { lookups: [found!.column_name], left: null };
  const held = await sheetFreeWithin(sheetId, waitMs);
  found = ours();
  if (ready(found)) return { lookups: [found!.column_name], left: null };
  const was = found ? [found.column_name] : [];
  if (held) {
    return { lookups: was, left: `The "${found?.column_name ?? OPEN_ROLES.count}" column is ${found ? 'pointed at '
      + `"${o.websiteColumn}"` : 'added'} once the sheet is free (${held}).` };
  }
  const column = found?.column_name ?? freeName(OPEN_ROLES.count, getSheetColumns(sheetId, userId));
  const made = await startLookupColumn(userId, sheetId, {
    column, sourceColumn: o.websiteColumn, otherSheetId: rolesSheetId, matchColumn: ROLE_COLUMNS.domain,
    match: 'equals', returns: 'count',
  });
  if ('fail' in made) {
    return { lookups: was, left: `The "${column}" column isn't up to date yet (${made.message}). The next run does `
      + 'it.' };
  }
  if (!found) writeColumnDescription(sheetId, userId, made.ok.column, OPEN_ROLES_WORDS.count);
  return { lookups: [made.ok.column], left: null };
}

// The lookups right after a start, without waiting: there already, or made now when the sheet is free; else in the
// background as soon as it is (the start's setup of its rows usually holds it), or at the next run.
export async function lookupsAfterStart(userId: string, sheetId: string, o: OpenRolesOptions, rolesSheetId: string):
  Promise<LookupsNow> {
  let now: LookupsNow;
  try {
    now = await ensureLookups(userId, sheetId, o, rolesSheetId, 0);
  } catch (error) {
    now = { lookups: [], left: `The "${OPEN_ROLES.count}" column isn't there yet (${(error as Error).message}).` };
  }
  if (!now.left) return now;
  void ensureLookups(userId, sheetId, o, rolesSheetId, OPEN_ROLES_LOOKUPS_LATER_MS).then(later => {
    if (later.left) console.error(`Open roles: ${later.left} The next run adds it.`);
  }, (error: Error) => {
    console.error(`Open roles: the lookups weren't added (${error.message}); the next run adds them.`);
  });
  return now;
}

// The lookups on the company sheet looking in Open roles, while their columns are there (whatever their names now).
const lookupsOf = (userId: string, sheetId: string, rolesSheetId: string): LookupColumnRow[] => {
  const listed = new Set(getSheetColumns(sheetId, userId));
  return (db.prepare(`SELECT * FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND other_sheet_id = ?
    AND match_column = ?`).all(sheetId, userId, rolesSheetId, ROLE_COLUMNS.domain) as LookupColumnRow[])
    .filter(r => listed.has(r.column_name));
};

const runStatus = (userId: string, runId: string): string | null => (db.prepare(
  'SELECT status FROM http_runs WHERE id = ? AND user_id = ?').pluck().get(runId, userId) as string | undefined)
  ?? null;

// Once the run's roles are in (hiring-check-watch.ts searchState), each lookup looks every row up again as soon as
// the sheet is free. A pause does it too (what was found so far), and the watch goes on: a resume ends in another
// look. Each look is a short read. In memory: a restart meanwhile, or a run started from the column's menu, leaves the
// columns as they were until the next run here, or the person's "Look up every row again".
const watching = new Set<string>();
export function lookAgainWhenDone(userId: string, sheetId: string, rolesSheetId: string, runId: string): void {
  if (watching.has(runId)) return;
  watching.add(runId);
  let looked: string | null = null;
  const later = () => { setTimeout(() => void look(), HIRING_CHECK_POLL_MS).unref(); };
  const look = async (): Promise<void> => {
    try {
      if (searchState(userId, runId).going) { later(); return; }
      const status = runStatus(userId, runId);
      if (status !== looked) {
        looked = status;
        for (const rec of lookupsOf(userId, sheetId, rolesSheetId)) {
          const held = await sheetFreeWithin(sheetId, OPEN_ROLES_LOOKUPS_LATER_MS);
          const out = held ? { fail: 'conflict', message: held } : await startLookupColumn(userId, sheetId,
            lookupInputOf(rec));
          if ('fail' in out) {
            console.error(`Open roles: "${rec.column_name}" wasn't looked up again (${out.message}); its menu's `
              + 'Look up every row again does it.');
          }
        }
      }
      if (status === 'paused') { later(); return; }
    } catch (error) {
      console.error(`Open roles: the counts weren't looked up again (${(error as Error).message}); the column `
        + 'menu\'s Look up every row again does it.');
    }
    watching.delete(runId);
  };
  later();
}
