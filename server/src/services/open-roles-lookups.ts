// The count on the company sheet for Open roles (services/open-roles.ts): a lookup counting each company's roles in
// the Open roles sheet by a cleaned domain on both sides (plans/open-roles-count.md). The company sheet's side is a
// clean column, the domain cleaner on the website column ("Website (domain)", following edits); each role's Domain is
// that same cleaner's answer, copied as the run adds it (lib/enrich-list.ts copy clean 'domain'). So `acme.com` and
// `https://www.acme.com/about` count as one, and a website written another way keeps its count. Both are made after
// a run's start (their fills hold the sheet, which the start's setup of its rows holds first), and the count is
// looked up again once a run's roles are in, as a lookup doesn't follow the sheet it looks in: any run of the column,
// however it started (lib/run-start-listeners.ts), and at boot the runs still going. Neither keeps the start waiting:
// a run start answers at once (CLAUDE.md), so what the sheet can't take yet is done in the background when it's free.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { writeColumnDescription } from '../lib/column-descriptions';
import { HIRING_CHECK_POLL_MS, OPEN_ROLES_LOOKUPS_LATER_MS } from '../lib/constants';
import { sheetFreeWithin } from '../lib/sheet-busy';
import { HIRING_DIRECT_TOOL_ID, OPEN_ROLES, OPEN_ROLES_WORDS, ROLE_COLUMNS } from '../lib/hiring/names';
import { openRolesOf, type OpenRolesOptions } from '../lib/hiring/open-roles-input';
import { inputTemplates, type EnrichRunConfig } from '../lib/enrich-run-config';
import { onEnrichmentRunStarted } from '../lib/run-start-listeners';
import { lookupInputOf, startLookupColumn } from './lookup-column';
import { startCleanColumn } from './clean-column';
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

// The company sheet's domain of the website column: a clean column with the domain cleaner, found by its record
// whatever its name, while its column is there.
const domainColumnOf = (userId: string, sheetId: string, website: string): string | null => {
  const listed = new Set(getSheetColumns(sheetId, userId));
  return (db.prepare(`SELECT column_name FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND source_column = ?
    AND cleaner = 'domain'`).pluck().all(sheetId, userId, website) as string[]).find(c => listed.has(c)) ?? null;
};

// The domain column, then the count on it, each made once (found by what it reads, whatever its name); a count that
// reads another column is pointed at this run's domain column. Each waits for the sheet first, at most waitMs (the
// run's start, or another fill, holds it), and looks again then: another call may have made it.
async function ensureLookups(userId: string, sheetId: string, o: OpenRolesOptions, rolesSheetId: string,
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
    const name = freeName(`${o.websiteColumn} (domain)`, getSheetColumns(sheetId, userId));
    const cleaned = await startCleanColumn(userId, sheetId,
      { source: o.websiteColumn, cleaner: 'domain', column: name });
    if ('fail' in cleaned) {
      return { lookups: was, left: `The "${name}" column isn't there yet (${cleaned.message}). The next run adds it.` };
    }
    domain = cleaned.ok.column;
    writeColumnDescription(sheetId, userId, domain, OPEN_ROLES_WORDS.domain);
    // Its fill holds the sheet in turn.
    held = await sheetFreeWithin(sheetId, waitMs);
    if (held) return later();
  }
  const column = found?.column_name ?? freeName(OPEN_ROLES.count, getSheetColumns(sheetId, userId));
  const made = await startLookupColumn(userId, sheetId, {
    column, sourceColumn: domain, otherSheetId: rolesSheetId, matchColumn: ROLE_COLUMNS.domain,
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
// look. Each look is a short read. Started for every run of the column (below), and again at boot for the runs still
// going (resumeOpenRolesWatches).
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

// An Open roles search column's run (its Open roles sheet), as openRolesInput lays it out, or null.
export function openRolesDestOf(config: EnrichRunConfig): string | null {
  const e = config.enrichment;
  if (e.toolId !== HIRING_DIRECT_TOOL_ID || !e.list?.keep || !e.list.destSheetId) return null;
  return openRolesOf(inputTemplates(config), e.list.maxItems) ? e.list.destSheetId : null;
}

// Any run of an Open roles column, however it started (the dialog, an agent, the column's menu, auto-run): its end
// looks the count up again.
onEnrichmentRunStarted((userId, sheetId, runId, config) => {
  const dest = openRolesDestOf(config);
  if (dest) lookAgainWhenDone(userId, sheetId, dest, runId);
});

// At boot: the runs of Open roles columns still going (a restart cut their watch short) are watched again.
export function resumeOpenRolesWatches(): void {
  const going = db.prepare(`SELECT id, user_id, sheet_id, config FROM http_runs WHERE status IN
    ('pending', 'running', 'paused') AND setup_only = 0 AND config LIKE ?`).all(`%${HIRING_DIRECT_TOOL_ID}%`) as
    Array<{ id: string; user_id: string; sheet_id: string; config: string | null }>;
  for (const r of going) {
    try {
      const dest = r.config ? openRolesDestOf(JSON.parse(r.config) as EnrichRunConfig) : null;
      if (dest) lookAgainWhenDone(r.user_id, r.sheet_id, dest, r.id);
    } catch (error) {
      console.error(`Open roles: run ${r.id} couldn't be watched again (${(error as Error).message}).`);
    }
  }
}
