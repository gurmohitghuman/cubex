// Hiring tables: the create form's limits and defaults, as the server has them
// (server/src/lib/constants-hiring.ts, ENRICH_LIST_MAX_ITEMS).
export const HIRING_MAX_ROLES = 20
export const HIRING_DEFAULT_PER_SEARCH = 25
export const HIRING_MAX_PER_SEARCH = 100
export const HIRING_DEFAULT_POSTED_DAYS = 30
export const HIRING_POSTED_CHOICES = [7, 14, 30, 60, 90] as const
// The job index's own labels (server lib/hiring/filters.ts).
export const HIRING_SENIORITY_LEVELS = [
  'Entry-Level', 'Junior / Associate', 'Mid-Level', 'Senior', 'Principal / Staff / Lead', 'Executive',
] as const
export const HIRING_EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Internship'] as const
// Filters on Companies (server lib/hiring/company-filters.ts): "at least N matching roles" at most.
export const HIRING_MAX_MIN_ROLES = 100
const plural = (n: number, w: string, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`
// What a table's filters on Companies leave out ('' for none), and the money line after it.
export function companyFilterWords(minRoles: number, leftOut: number): string {
  if (minRoles <= 1 && leftOut === 0) return ''
  const out = leftOut ? plural(leftOut, 'company', 'companies') : ''
  const what = minRoles > 1 && leftOut
    ? `Companies lists only companies with at least ${minRoles} matching roles, and leaves out ${out}.`
    : minRoles > 1 ? `Companies leaves out companies with fewer than ${minRoles} matching roles.`
    : `Companies leaves out ${out}.`
  return `${what} Their roles are still searched and paid for.`
}
// Making a table reads treg's catalog first.
export const HIRING_CREATE_TIMEOUT_MS = 60_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// A check's day (YYYY-MM-DD) as "Nov 19", with the year when it isn't this one.
export function checkDay(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-')
  const month = MONTHS[Number(m) - 1]
  if (!month || !d) return day
  return `${month} ${Number(d)}${Number(y) === now.getFullYear() ? '' : `, ${y}`}`
}
// How often the banner looks at a check still going.
export const HIRING_CHECK_POLL_MS = 3_000
