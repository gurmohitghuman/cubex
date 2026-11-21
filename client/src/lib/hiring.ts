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
