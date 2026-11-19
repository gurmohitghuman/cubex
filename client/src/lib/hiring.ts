// Hiring tables: the create form's limits and defaults, as the server has them
// (server/src/lib/constants-hiring.ts, ENRICH_LIST_MAX_ITEMS).
export const HIRING_MAX_ROLES = 20
export const HIRING_DEFAULT_PER_SEARCH = 25
export const HIRING_MAX_PER_SEARCH = 100
export const HIRING_DEFAULT_POSTED_DAYS = 30
export const HIRING_POSTED_CHOICES = [7, 14, 30, 60, 90] as const
// Making a table reads treg's catalog first.
export const HIRING_CREATE_TIMEOUT_MS = 60_000
// How often the banner looks at a check still going.
export const HIRING_CHECK_POLL_MS = 3_000
