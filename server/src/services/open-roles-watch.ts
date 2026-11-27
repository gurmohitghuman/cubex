// What follows any run of an Open roles column, however it started (the dialog, an agent, the column's menu,
// auto-run: lib/run-start-listeners.ts), as a lookup doesn't follow the sheet it looks in: once the run's roles are in
// (hiring-check-watch.ts searchState), the count is first checked (services/open-roles-lookups.ts ensureLookups: a
// count not on the domain column yet, a v0.8.48 sheet whose conversion didn't finish, is moved there, which looks it up
// whole), then looked up again as soon as the sheet is free, only when the run added roles (a whole-sheet refill for
// none would hold a big sheet for nothing). A pause does it too (what was found so far), and the watch goes on: a
// resume ends in another look. At boot the runs left going are watched again, and a conversion a restart cut short is
// finished (finishOpenRolesConversions).
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { HIRING_CHECK_POLL_MS, OPEN_ROLES_LOOKUPS_LATER_MS } from '../lib/constants';
import { sheetFreeWithin } from '../lib/sheet-busy';
import { HIRING_DIRECT_TOOL_ID, ROLE_COLUMNS } from '../lib/hiring/names';
import { openRolesOf, type OpenRolesOptions } from '../lib/hiring/open-roles-input';
import { inputTemplates, isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import { onEnrichmentRunStarted } from '../lib/run-start-listeners';
import { lookupInputOf, startLookupColumn } from './lookup-column';
import { searchState } from './hiring-check-watch';
import { ensureLookups } from './open-roles-lookups';
import type { LookupColumnRow } from '../lib/lookup-columns';

// An Open roles search column's run (its Open roles sheet and its ask), as openRolesInput lays it out, or null.
export function openRolesRunOf(config: unknown): { dest: string; o: OpenRolesOptions } | null {
  if (!isEnrichmentConfig(config)) return null;
  const e = config.enrichment;
  if (e.toolId !== HIRING_DIRECT_TOOL_ID || !e.list?.keep || !e.list.destSheetId) return null;
  const o = openRolesOf(inputTemplates(config), e.list.maxItems);
  return o ? { dest: e.list.destSheetId, o } : null;
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

const watching = new Set<string>();
// Whether a run's end is still watched (tests wait on it).
export const openRolesWatching = (runId: string): boolean => watching.has(runId);

export function lookAgainWhenDone(userId: string, sheetId: string, rolesSheetId: string, runId: string,
  o: OpenRolesOptions): void {
  if (watching.has(runId)) return;
  watching.add(runId);
  let looked: string | null = null;
  let addedSeen = 0;
  const later = () => { setTimeout(() => void look(), HIRING_CHECK_POLL_MS).unref(); };
  const look = async (): Promise<void> => {
    try {
      const state = searchState(userId, runId);
      if (state.going) { later(); return; }
      const status = runStatus(userId, runId);
      if (status !== looked) {
        looked = status;
        const fixed = await ensureLookups(userId, sheetId, o, rolesSheetId, OPEN_ROLES_LOOKUPS_LATER_MS);
        if (fixed.left) console.error(`Open roles: ${fixed.left}`);
        if (!fixed.fresh && state.added > addedSeen) await refill(userId, sheetId, rolesSheetId);
        addedSeen = state.added;
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

async function refill(userId: string, sheetId: string, rolesSheetId: string): Promise<void> {
  for (const rec of lookupsOf(userId, sheetId, rolesSheetId)) {
    const held = await sheetFreeWithin(sheetId, OPEN_ROLES_LOOKUPS_LATER_MS);
    const out = held ? { fail: 'conflict', message: held }
      : await startLookupColumn(userId, sheetId, lookupInputOf(rec));
    if ('fail' in out) {
      console.error(`Open roles: "${rec.column_name}" wasn't looked up again (${out.message}); its menu's Look up `
        + 'every row again does it.');
    }
  }
}

onEnrichmentRunStarted((userId, sheetId, runId, config) => {
  const run = openRolesRunOf(config);
  if (run) lookAgainWhenDone(userId, sheetId, run.dest, runId, run.o);
});

// At boot: the runs of Open roles columns a restart cut short (still going, by idx_http_runs_active's own condition,
// or with roles still being added) are watched again.
export function resumeOpenRolesWatches(): void {
  const going = db.prepare(`SELECT id, user_id, sheet_id, config FROM http_runs
    WHERE (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL) AND setup_only = 0
    UNION SELECT id, user_id, sheet_id, config FROM http_runs WHERE id IN
      (SELECT run_id FROM enrichment_list_items WHERE status = 'pending')`).all() as
    Array<{ id: string; user_id: string; sheet_id: string; config: string | null }>;
  for (const r of going) {
    try {
      const run = r.config?.includes(HIRING_DIRECT_TOOL_ID) ? openRolesRunOf(JSON.parse(r.config)) : null;
      if (run) lookAgainWhenDone(r.user_id, r.sheet_id, run.dest, r.id, run.o);
    } catch (error) {
      console.error(`Open roles: run ${r.id} couldn't be watched again (${(error as Error).message}).`);
    }
  }
}

// At boot: an Open roles count still on the website column while its domain column is there (a conversion a restart
// or a busy sheet cut short) is finished in the background. Found from the lookup and clean records (small tables),
// then confirmed by the sheet's newest run into that Open roles sheet.
export function finishOpenRolesConversions(): void {
  const left = db.prepare(`SELECT l.user_id, l.sheet_id, l.other_sheet_id FROM lookup_columns l
    JOIN clean_columns c ON c.sheet_id = l.sheet_id AND c.user_id = l.user_id AND c.source_column = l.source_column
      AND c.cleaner = 'domain'
    WHERE l.returns = 'count' AND l.match_column = ?`).all(ROLE_COLUMNS.domain) as
    Array<{ user_id: string; sheet_id: string; other_sheet_id: string }>;
  const newest = db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ? AND user_id = ? AND dest_sheet_id = ?
    AND setup_only = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck();
  for (const l of left) {
    const config = newest.get(l.sheet_id, l.user_id, l.other_sheet_id) as string | undefined;
    let run: ReturnType<typeof openRolesRunOf> = null;
    try { run = config ? openRolesRunOf(JSON.parse(config)) : null; } catch { run = null; }
    if (!run || run.dest !== l.other_sheet_id) continue;
    void ensureLookups(l.user_id, l.sheet_id, run.o, l.other_sheet_id, OPEN_ROLES_LOOKUPS_LATER_MS).then(out => {
      if (out.left) console.error(`Open roles: ${out.left}`);
    }, (error: Error) => console.error(`Open roles: a count wasn't moved to its domain column (${error.message}).`));
  }
}
