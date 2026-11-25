// A hiring table's filters on Companies changed after create (lib/hiring/company-filters.ts), for the app, /api/v1
// and MCP: min_roles, leave_out_companies or both; one left out keeps what it was. They apply from the next check:
// its summary reads all of Roles, so a company kept off before gets its row then if it passes now, and a row
// already on Companies stays, kept up to date as one always is. The search, its free count and its estimate stay
// the same. Refused while a check is going (its summary reads them as it starts). Logged on Companies' History.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { logSheetChange } from '../lib/change-log';
import { COMPANY_FILTER_NAMES, parseCompanyFilters, type CompanyFilters } from '../lib/hiring/company-filters';
import { FILTER_COLUMNS } from '../lib/hiring/names';
import {
  companyFiltersOf, hiringCheckGoing, hiringFor, hiringView, type HiringRecord, type HiringView,
} from './hiring-store';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// The table's "only these companies" (its Searches' cells, as create wrote them): one also left out is refused.
function onlyTheseOf(userId: string, rec: HiringRecord): string[] {
  const column = FILTER_COLUMNS.companies;
  if (!rec.searches_sheet_id || !getSheetColumns(rec.searches_sheet_id, userId).includes(column)) return [];
  const cells = db.prepare(`SELECT DISTINCT json_extract(data, ?) FROM rows WHERE sheet_id = ? AND user_id = ?`)
    .pluck().all(`$."${column}"`, rec.searches_sheet_id, userId) as Array<string | null>;
  return [...new Set(cells.flatMap(c => (c ?? '').split(',').map(d => d.trim()).filter(Boolean)))];
}

const words = (f: CompanyFilters): string => {
  const min = f.minRoles > 1 ? `companies with at least ${f.minRoles} matching roles` : 'every company';
  const out = f.leaveOutCompanies.length ? `, leaving out ${f.leaveOutCompanies.join(', ')}` : '';
  return `${min}${out}`;
};

export function setHiringCompanyFilters(
  userId: string, idOrSheet: unknown, body: Record<string, unknown>, names: 'camel' | 'snake',
): { ok: HiringView } | RunFail {
  const rec = hiringFor(userId, idOrSheet);
  if (!rec) return { fail: 'not_found', message: 'Hiring table not found' };
  const n = COMPANY_FILTER_NAMES[names];
  const given = [n.minRoles, n.leaveOutCompanies].filter(k => body[k] !== undefined);
  if (given.length === 0) return bad(`Send ${n.minRoles}, ${n.leaveOutCompanies} or both.`);
  if (hiringCheckGoing(userId, rec.id)) {
    return { fail: 'conflict', message: 'A check of this table is going: change its filters on Companies once it\'s '
      + 'done.' };
  }
  const now = companyFiltersOf(rec);
  const next = parseCompanyFilters({
    [n.minRoles]: body[n.minRoles] === undefined ? now.minRoles : body[n.minRoles],
    [n.leaveOutCompanies]: body[n.leaveOutCompanies] === undefined ? now.leaveOutCompanies : body[n.leaveOutCompanies],
  }, names, onlyTheseOf(userId, rec));
  if (typeof next === 'string') return bad(next);
  db.prepare('UPDATE hiring_signals SET min_roles = ?, leave_out_companies = ? WHERE id = ? AND user_id = ?')
    .run(next.minRoles, JSON.stringify(next.leaveOutCompanies), rec.id, userId);
  logSheetChange(rec.companies_sheet_id, userId, 'hiring_filters',
    `Companies now gets a row for ${words(next)}, from the next check`,
    { detail: { min_roles: next.minRoles, leave_out_companies: next.leaveOutCompanies,
      was: { min_roles: now.minRoles, leave_out_companies: now.leaveOutCompanies } } });
  return { ok: hiringView(hiringFor(userId, rec.id)!) };
}
