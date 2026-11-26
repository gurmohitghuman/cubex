// A hiring table's record and the record of each check (migration 061):
// read, moved to the next stage, and shown as the app, /api/v1 and MCP show them.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import type { CompanyFilters } from '../lib/hiring/company-filters';

export interface HiringRecord {
  id: string; user_id: string; table_id: string; companies_sheet_id: string;
  roles_sheet_id: string | null; searches_sheet_id: string | null;
  roles: string; country: string | null; place: string | null; posted_within_days: number | null;
  min_roles: number; leave_out_companies: string;   // its filters on Companies (migration 062)
  created_at: string;
}

export type HiringStage = 'searching' | 'summarizing' | 'done' | 'stopped';
export interface HiringCheckRow {
  id: string; user_id: string; signal_id: string; label: string; since_label: string | null; stage: HiringStage;
  run_id: string | null; searches: number; roles_added: number; companies_new: number;
  companies_hiring_more: number; companies_kept_off: number; problems: string; created_at: string;
}

const list = (s: string): string[] => {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

// The table's filters on Companies (lib/hiring/company-filters.ts).
export const companyFiltersOf = (r: HiringRecord): CompanyFilters =>
  ({ minRoles: Math.max(1, r.min_roles ?? 1), leaveOutCompanies: list(r.leave_out_companies ?? '[]') });

// The sheet is there and not in the trash.
export const sheetLive = (userId: string, id: string | null): boolean => !!id && !!db.prepare(`SELECT 1 FROM sheets
  WHERE id = ? AND user_id = ? AND trash_id IS NULL`).get(id, userId);

// A table by its record's id, or by its Companies sheet's id (what get_workspace (all_tables) shows); not one in the
// trash.
export function hiringFor(userId: string, idOrSheet: unknown): HiringRecord | null {
  if (typeof idOrSheet !== 'string') return null;
  return (db.prepare(`SELECT h.* FROM hiring_signals h JOIN sheets s ON s.id = h.companies_sheet_id
    WHERE (h.id = ? OR h.companies_sheet_id = ?) AND h.user_id = ? AND s.trash_id IS NULL LIMIT 1`)
    .get(idOrSheet, idOrSheet, userId) as HiringRecord | undefined) ?? null;
}

// The table a sheet of it belongs to (its banner shows on all three).
export const hiringForSheet = (userId: string, sheetId: string): HiringRecord | null =>
  (db.prepare(`SELECT h.* FROM hiring_signals h JOIN sheets s ON s.id = h.companies_sheet_id
    WHERE ? IN (h.companies_sheet_id, h.roles_sheet_id, h.searches_sheet_id) AND h.user_id = ?
      AND s.trash_id IS NULL LIMIT 1`).get(sheetId, userId) as HiringRecord | undefined) ?? null;

export const loadHiringCheck = (userId: string, id: string): HiringCheckRow | undefined =>
  db.prepare('SELECT * FROM hiring_checks WHERE id = ? AND user_id = ?').get(id, userId) as HiringCheckRow | undefined;

export const hiringCheckGoing = (userId: string, signalId: string): HiringCheckRow | undefined => db.prepare(`SELECT *
  FROM hiring_checks WHERE signal_id = ? AND user_id = ? AND stage IN ('searching', 'summarizing') LIMIT 1`)
  .get(signalId, userId) as HiringCheckRow | undefined;

// The day of the newest check that searched: what the next one's "New since" names.
export const lastSearchedDay = (userId: string, signalId: string): string | null =>
  (db.prepare(`SELECT label FROM hiring_checks WHERE signal_id = ? AND user_id = ? AND run_id IS NOT NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck().get(signalId, userId) as string | undefined) ?? null;

// null: another check of the table went in first (the partial unique index).
export function insertHiringCheck(
  userId: string, signalId: string, label: string, sinceLabel: string | null, searches: number,
): string | null {
  const id = uuidv4();
  try {
    db.prepare(`INSERT INTO hiring_checks (id, user_id, signal_id, label, since_label, stage, searches)
      VALUES (?, ?, ?, ?, ?, 'searching', ?)`).run(id, userId, signalId, label, sinceLabel, searches);
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
    throw error;
  }
  return id;
}

export function updateHiringCheck(userId: string, id: string, set: {
  stage?: HiringStage; runId?: string; rolesAdded?: number; companiesNew?: number; companiesHiringMore?: number;
  companiesKeptOff?: number; problems?: string[];
}): void {
  db.transaction(() => {
    const now = loadHiringCheck(userId, id);
    if (!now) return;
    const problems = [...list(now.problems), ...(set.problems ?? [])];
    db.prepare(`UPDATE hiring_checks SET stage = ?, run_id = ?, roles_added = ?, companies_new = ?,
        companies_hiring_more = ?, companies_kept_off = ?, problems = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`)
      .run(set.stage ?? now.stage, set.runId ?? now.run_id, set.rolesAdded ?? now.roles_added,
        set.companiesNew ?? now.companies_new, set.companiesHiringMore ?? now.companies_hiring_more,
        set.companiesKeptOff ?? now.companies_kept_off, JSON.stringify([...new Set(problems)]), id, userId);
  }).immediate(); // read then write: deferred, a run's worker writing meanwhile makes it SQLITE_BUSY
}

export interface HiringCheckView {
  id: string; label: string; since: string | null; stage: HiringStage; checkedAt: string; runId: string | null;
  searches: number; rolesAdded: number; companiesNew: number; companiesHiringMore: number;
  companiesKeptOff: number;   // companies its table's filters on Companies kept off (no row)
  problems: string[];
}
export const hiringCheckView = (r: HiringCheckRow): HiringCheckView => ({
  id: r.id, label: r.label, since: r.since_label, stage: r.stage, checkedAt: r.created_at, runId: r.run_id,
  searches: r.searches, rolesAdded: r.roles_added, companiesNew: r.companies_new,
  companiesHiringMore: r.companies_hiring_more, companiesKeptOff: r.companies_kept_off, problems: list(r.problems),
});

export interface HiringView {
  id: string; tableId: string; companiesSheetId: string; rolesSheetId: string | null;
  searchesSheetId: string | null; roles: string[]; country: string | null; place: string | null;
  postedWithinDays: number | null; minRoles: number; leaveOutCompanies: string[]; createdAt: string;
  checks: HiringCheckView[];
}
export const hiringView = (r: HiringRecord, limit = 5): HiringView => ({
  id: r.id, tableId: r.table_id, companiesSheetId: r.companies_sheet_id, rolesSheetId: r.roles_sheet_id,
  searchesSheetId: r.searches_sheet_id, roles: list(r.roles), country: r.country, place: r.place,
  postedWithinDays: r.posted_within_days, ...companyFiltersOf(r), createdAt: r.created_at,
  checks: (db.prepare(`SELECT * FROM hiring_checks WHERE signal_id = ? AND user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(r.id, r.user_id, limit) as HiringCheckRow[])
    .map(hiringCheckView),
});
