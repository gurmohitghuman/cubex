// Lookup steps name another sheet's columns (LookupChoices). A rename there
// rewrites, inside the rename's transaction, the newest run of each waterfall
// column of the account whose lookup steps read it: what an edit, a rerun and
// auto-run start from, and an active run (its worker reads the names again).
// Older runs keep the old name: their configs are history. A delete there isn't
// followed: the step finds the column gone when it runs and pauses the run, and
// a start or auto-run refuses the step until the waterfall is edited.
// waterfallLookupNeeds lists the looked-up columns those newest runs read, so
// the lookup sweep keeps their index (services/waterfall-lookup-sweep.ts).
import { db } from '../db';
import { getSheetColumns } from '../sql-helpers';
import { waterfallConfigOf, type LookupChoices, type WaterfallRunConfig } from './config';

// The newest run of each listed column of the account's sheets, when it's a
// waterfall whose config holds `needle`: one probe of the (sheet, column, time)
// index per column, however many runs auto-run left behind.
function newestWaterfallRuns(userId: string, needle: string): Array<{ id: string; config: WaterfallRunConfig }> {
  const sheets = db.prepare('SELECT id FROM sheets WHERE user_id = ?').pluck().all(userId) as string[];
  const newest = db.prepare(`SELECT id, config FROM http_runs WHERE sheet_id = ? AND master_column_name = ?
    AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const out: Array<{ id: string; config: WaterfallRunConfig }> = [];
  for (const sheetId of sheets) {
    for (const column of getSheetColumns(sheetId, userId, false)) {
      const r = newest.get(sheetId, column, userId) as { id: string; config: string | null } | undefined;
      if (!r?.config?.includes(needle)) continue;
      const config = waterfallConfigOf(r.config);
      if (config) out.push({ id: r.id, config });
    }
  }
  return out;
}

const lookupsOf = (config: WaterfallRunConfig): LookupChoices[] =>
  config.waterfall.steps.flatMap(s => (s.choices?.kind === 'lookup' ? [s.choices] : []));

// Inside the rename's transaction, on the renamed column's sheet.
export function renameWaterfallLookupRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  const save = db.prepare('UPDATE http_runs SET config = ? WHERE id = ?');
  for (const run of newestWaterfallRuns(userId, JSON.stringify({ sheetId }).slice(1, -1))) {
    let changed = false;
    for (const c of lookupsOf(run.config)) {
      if (c.sheetId !== sheetId) continue;
      if (c.matchColumn === oldName) { c.matchColumn = newName; changed = true; }
      if (c.returnColumn === oldName) { c.returnColumn = newName; changed = true; }
    }
    if (changed) save.run(JSON.stringify(run.config), run.id);
  }
}

// The other sheets' columns the account's waterfall columns look up: sheet id →
// column → whether a contains step reads it (it then needs the text index).
export function waterfallLookupNeeds(userId: string): Map<string, Map<string, boolean>> {
  const out = new Map<string, Map<string, boolean>>();
  for (const run of newestWaterfallRuns(userId, '"kind":"lookup"')) {
    for (const c of lookupsOf(run.config)) {
      const columns = out.get(c.sheetId) ?? new Map<string, boolean>();
      columns.set(c.matchColumn, (columns.get(c.matchColumn) ?? false) || c.mode === 'contains');
      out.set(c.sheetId, columns);
    }
  }
  return out;
}
