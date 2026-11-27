// The count on the company sheet for Open roles (services/open-roles.ts): a lookup counting each company's roles in
// the Open roles sheet by a cleaned domain on both sides (plans/open-roles-count.md). The company sheet's side is a
// clean column, the domain cleaner on the website column ("Website (domain)", following edits); each role's Domain is
// that same cleaner's answer, copied as the run adds it (lib/enrich-list.ts copy clean 'domain'). So `acme.com` and
// `https://www.acme.com/about` count as one, and a website written another way keeps its count. Both are made after
// a run's start (their fills hold the sheet, which the start's setup of its rows holds first), and checked again,
// and the count looked up again, after any run of the column (services/open-roles-watch.ts). Neither keeps a start
// waiting: a run start answers at once (CLAUDE.md), so what the sheet can't take yet is done when it's free.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { writeColumnDescription } from '../lib/column-descriptions';
import { findColumnNameCollision } from '../lib/column-names';
import { OPEN_ROLES_LOOKUPS_LATER_MS } from '../lib/constants';
import { sheetFreeWithin } from '../lib/sheet-busy';
import { OPEN_ROLES, OPEN_ROLES_WORDS, ROLE_COLUMNS } from '../lib/hiring/names';
import type { OpenRolesOptions } from '../lib/hiring/open-roles-input';
import { startLookupColumn } from './lookup-column';
import { startCleanColumn } from './clean-column';
import { cleanRolesDomains } from './open-roles-convert';

// A name not taken in `taken`: base, else "base 2", "base 3"... (case aside: a sheet's name).
export function freeName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map(t => t.toLowerCase()));
  let name = base;
  for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

// A column name no column of the sheet clashes with, as a new column is checked (case, or the /token form
// "Website domain" and "website_domain" share): base, else "base 2", "base 3"...
export function freeColumnName(base: string, columns: readonly string[]): string {
  let name = base;
  for (let n = 2; findColumnNameCollision(name, columns); n++) name = `${base} ${n}`;
  return name;
}

// fresh: this call made the count, or pointed it at the domain column, so it was just looked up whole.
export interface LookupsNow { lookups: string[]; left: string | null; fresh?: true }

// The company sheet's domain of the website column: a clean column with the domain cleaner, found by its record
// whatever its name, while its column is there.
const domainColumnOf = (userId: string, sheetId: string, website: string): string | null => {
  const listed = new Set(getSheetColumns(sheetId, userId));
  return (db.prepare(`SELECT column_name FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND source_column = ?
    AND cleaner = 'domain'`).pluck().all(sheetId, userId, website) as string[]).find(c => listed.has(c)) ?? null;
};

// The domain column, then the count on it, each made once (found by what it reads, whatever its name); a count that
// reads another column (a sheet searched on v0.8.48) has its roles' Domain cleaned, then is pointed at the domain
// column. Each step waits for the sheet first, at most waitMs (the run's start, another fill or the conversion holds
// it), and looks again then: another call may have made it.
export async function ensureLookups(userId: string, sheetId: string, o: OpenRolesOptions, rolesSheetId: string,
  waitMs: number): Promise<LookupsNow> {
  const ours = () => (db.prepare(`SELECT column_name, source_column FROM lookup_columns WHERE sheet_id = ?
    AND user_id = ? AND other_sheet_id = ? AND match_column = ? AND returns = 'count'`)
    .all(sheetId, userId, rolesSheetId, ROLE_COLUMNS.domain) as Array<{ column_name: string; source_column: string }>)
    .find(h => getSheetColumns(sheetId, userId).includes(h.column_name));
  const ready = (f: ReturnType<typeof ours>, domain: string | null) => !!f && !!domain && f.source_column === domain;
  let domain = domainColumnOf(userId, sheetId, o.websiteColumn);
  let found = ours();
  if (ready(found, domain)) return { lookups: [found!.column_name], left: null };
  let held = await sheetFreeWithin(sheetId, waitMs);
  domain = domainColumnOf(userId, sheetId, o.websiteColumn);
  found = ours();
  if (ready(found, domain)) return { lookups: [found!.column_name], left: null };
  const was = found ? [found.column_name] : [];
  const later = (): LookupsNow => ({ lookups: was, left: `The "${found?.column_name ?? OPEN_ROLES.count}" column is `
    + `${found ? 'brought up to date' : 'added'} once the sheet is free (${held}).` });
  if (held) return later();
  if (!domain) {
    const name = freeColumnName(`${o.websiteColumn} (domain)`, getSheetColumns(sheetId, userId));
    const cleaned = await startCleanColumn(userId, sheetId,
      { source: o.websiteColumn, cleaner: 'domain', column: name });
    if ('fail' in cleaned) return { lookups: was, left: `The "${name}" column isn't there yet (${cleaned.message}).` };
    domain = cleaned.ok.column;
    writeColumnDescription(sheetId, userId, domain, OPEN_ROLES_WORDS.domain);
  }
  if (found) {
    // A count from before the domain column (v0.8.48): its roles' Domain made the same key first.
    held = await sheetFreeWithin(rolesSheetId, waitMs);
    const converted = held ? { held } : await cleanRolesDomains(userId, rolesSheetId);
    if ('held' in converted) {
      return { lookups: was, left: `The "${found.column_name}" column is brought up to date once the Open roles sheet `
        + `is free (${converted.held}).` };
    }
  }
  // The domain column's fill, and the conversion's time, can have let something take the sheet meanwhile.
  held = await sheetFreeWithin(sheetId, waitMs);
  if (held) return later();
  const column = found?.column_name ?? freeColumnName(OPEN_ROLES.count, getSheetColumns(sheetId, userId));
  const made = await startLookupColumn(userId, sheetId, {
    column, sourceColumn: domain, otherSheetId: rolesSheetId, matchColumn: ROLE_COLUMNS.domain,
    match: 'equals', returns: 'count',
  });
  if ('fail' in made) return { lookups: was, left: `The "${column}" column isn't up to date yet (${made.message}).` };
  if (!found) writeColumnDescription(sheetId, userId, made.ok.column, OPEN_ROLES_WORDS.count);
  return { lookups: [made.ok.column], left: null, fresh: true };
}

// The lookups right after a start, without waiting: there already, or made now when the sheet is free; else in the
// background as soon as it is (the start's setup of its rows usually holds it), or after the run.
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
    if (later.left) console.error(`Open roles: ${later.left} The run's end tries again.`);
  }, (error: Error) => {
    console.error(`Open roles: the lookups weren't added (${error.message}); the run's end tries again.`);
  });
  return now;
}
