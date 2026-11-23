// A hiring table's filters on Companies, parsed strictly (pure): after the
// search, a company gets a row on Companies only with at least min_roles
// matching roles (the roles Roles holds for it), and only when its website
// isn't left out. Their roles are still searched and paid for: no job index
// takes either filter, so the search, its free count and its estimate stay the
// same. services/hiring-summarize-write.ts applies them to the companies with
// no row yet; a row already there is kept up to date. The same parse serves
// the app, /api/v1 and MCP.
import { digitsAsNumber } from '../digits-text';
import { HIRING_MAX_LEFT_OUT, HIRING_MAX_MIN_ROLES } from '../constants';
import { companyKey } from './company-key';
import { FILTER_NAMES, websitesOf } from './filters';

export interface CompanyFilters {
  minRoles: number;              // 1: every company
  leaveOutCompanies: string[];   // websites
}
export const NO_COMPANY_FILTERS: CompanyFilters = { minRoles: 1, leaveOutCompanies: [] };

// The names the asker sends: the app camelCase, /api/v1 and MCP snake_case.
export const COMPANY_FILTER_NAMES = {
  camel: { minRoles: 'minRoles', leaveOutCompanies: 'leaveOutCompanies' },
  snake: { minRoles: 'min_roles', leaveOutCompanies: 'leave_out_companies' },
} as const;

export const minRolesRefusal = (name: string) => `${name} must be a whole number from 1 to ${HIRING_MAX_MIN_ROLES}.`;
export const hasCompanyFilters = (f: CompanyFilters): boolean => f.minRoles > 1 || f.leaveOutCompanies.length > 0;

// onlyThese: the websites of the table's "only these companies" (lib/hiring/filters.ts); one also left out is refused.
export function parseCompanyFilters(v: Record<string, unknown>, names: 'camel' | 'snake', onlyThese: string[]):
  CompanyFilters | string {
  const n = COMPANY_FILTER_NAMES[names];
  // Also as digits ("3"), as MCP's lenientInt takes it; left out or null: every company.
  const min = digitsAsNumber(v[n.minRoles] ?? 1);
  if (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 1 || min > HIRING_MAX_MIN_ROLES) {
    return minRolesRefusal(n.minRoles);
  }
  const left = websitesOf(v[n.leaveOutCompanies], n.leaveOutCompanies, HIRING_MAX_LEFT_OUT);
  if (typeof left === 'string') return left;
  // Compared as the summary keys a company: careers.ramp.com left out is ramp.com, the only company searched.
  const only = new Map(onlyThese.map(d => [companyKey(d, '')?.key, d]));
  for (const d of left) {
    const key = companyKey(d, '');
    if (!key || key.byName) {
      return `${n.leaveOutCompanies} can't match ${d} to a company: give the company's website, such as ramp.com.`;
    }
    const o = only.get(key.key);
    if (o === undefined) continue;
    const companies = FILTER_NAMES[names].companies;
    return o === d ? `${d} is in both ${companies} and ${n.leaveOutCompanies}: take it out of one.`
      : `${d} in ${n.leaveOutCompanies} is the same company as ${o} in ${companies}: take it out of one.`;
  }
  return { minRoles: min, leaveOutCompanies: left };
}

// What the summary keeps off Companies (null: nothing): the websites left out as the summary keys a company
// (lib/hiring/company-key.ts: careers.ramp.com is ramp.com).
export interface CompanyKeep { minRoles: number; leftOut: Set<string> }
export function companyKeep(f: CompanyFilters): CompanyKeep | null {
  if (!hasCompanyFilters(f)) return null;
  const keys = f.leaveOutCompanies.map(d => companyKey(d, '')).filter(k => k && !k.byName).map(k => k!.key);
  return { minRoles: f.minRoles, leftOut: new Set(keys) };
}

// A company the filters keep off: too few roles, or its website left out (a company known by name only can't be).
export const keptOff = (k: CompanyKeep, acc: { count: number; domain: string }): boolean =>
  acc.count < k.minRoles || (acc.domain !== '' && k.leftOut.has(acc.domain));
