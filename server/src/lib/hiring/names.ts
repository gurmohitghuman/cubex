// A hiring table's names (pure): its three sheets, their columns and the
// search it runs. Columns are found by these names (a renamed one is left out
// of the summary, with a problem saying so).

// treg's routed job search: open roles by title across companies.
export const HIRING_TOOL_ID = 'treg.companies.jobs.search';
// The job index a table with More filters searches directly (the routed search takes none of them).
export const HIRING_DIRECT_TOOL_ID = 'hirebase.jobs.search';
export const HIRING_DIRECT_PROVIDER = 'hirebase';
export const isHiringSearchTool = (toolId: string | undefined): boolean =>
  toolId === HIRING_TOOL_ID || toolId === HIRING_DIRECT_TOOL_ID;

export const HIRING_SHEETS = { companies: 'Companies', roles: 'Roles', searches: 'Searches' } as const;

export const COMPANY_COLUMNS = {
  company: 'Company', domain: 'Domain', openRoles: 'Open roles', titles: 'Role titles', newest: 'Newest posted',
  links: 'Links', newSince: 'New since last check', newRoles: 'New roles', firstSeen: 'First seen',
} as const;
export type CompanyColumn = keyof typeof COMPANY_COLUMNS;

export const ROLE_COLUMNS = {
  title: 'Title', company: 'Company', domain: 'Domain', team: 'Team', location: 'Location', posted: 'Posted',
  link: 'Link', firstSeen: 'First seen', search: 'Search',
} as const;
export type RoleColumn = keyof typeof ROLE_COLUMNS;

// The Searches sheet: one row per role title; "Roles found" is the list enrichment's status column.
export const SEARCH_COLUMNS = {
  role: 'Role title', country: 'Country', place: 'Place', days: 'Posted within days', status: 'Roles found',
} as const;
// A table with More filters: one column each, before "Roles found" (lib/hiring/filters.ts).
export const FILTER_COLUMNS = {
  descriptionWords: 'Description words', leaveOutDescriptionWords: 'Description words left out',
  leaveOutTitleWords: 'Title words left out', seniority: 'Seniority', employmentTypes: 'Employment type',
  companies: 'Only these companies',
} as const;

export const SHEET_WORDS = {
  companies: 'One row per company hiring for these roles, summed up from Roles at each check. Filter New roles '
    + 'above 0 for the companies with roles new since the last check.',
  roles: 'Every open role the searches found, one row each. A role found again at a later check is not added '
    + 'again; First seen is the day of the check that found it.',
  searches: 'One search per row. Add a row to search for another role title; Check again searches every row.',
};

export const COLUMN_WORDS: Record<'companies' | 'roles' | 'searches', Record<string, string>> = {
  companies: {
    [COMPANY_COLUMNS.openRoles]: 'Roles in the Roles sheet for this company.',
    [COMPANY_COLUMNS.titles]: 'The titles of those roles (the first few).',
    [COMPANY_COLUMNS.newest]: 'The day the newest of those roles was posted.',
    [COMPANY_COLUMNS.links]: 'Links to the newest roles.',
    [COMPANY_COLUMNS.newSince]: 'Roles the latest check found that earlier checks did not. Empty: nothing new.',
    [COMPANY_COLUMNS.newRoles]: 'How many roles are new since the last check.',
    [COMPANY_COLUMNS.firstSeen]: 'The day of the check that first found this company hiring.',
  },
  roles: {
    [ROLE_COLUMNS.firstSeen]: 'The day of the check that found this role.',
    [ROLE_COLUMNS.search]: 'The role title searched for.',
  },
  searches: {
    [SEARCH_COLUMNS.country]: 'A two-letter country code, such as US. Empty: any country.',
    [SEARCH_COLUMNS.place]: 'A city or region, such as Texas. Empty: anywhere in the country.',
    [SEARCH_COLUMNS.days]: 'Only roles posted in the last this many days. Empty: any time.',
  },
};

// A table with More filters: its Searches columns' words (the job index takes a country's name).
export const FILTER_COLUMN_WORDS: Record<string, string> = {
  [SEARCH_COLUMNS.country]: 'A country, such as United States. Empty: any country.',
  [FILTER_COLUMNS.descriptionWords]: 'Roles that mention these words come first (commas between words). A word '
    + 'starting with - leaves out roles whose description mentions it.',
  [FILTER_COLUMNS.leaveOutDescriptionWords]: 'Leave out roles whose description mentions any of these words.',
  [FILTER_COLUMNS.leaveOutTitleWords]: 'Leave out roles whose title has any of these words.',
  [FILTER_COLUMNS.seniority]: 'Only roles at these levels: Entry-Level, Junior / Associate, Mid-Level, Senior, '
    + 'Principal / Staff / Lead, Executive. Empty: any level.',
  [FILTER_COLUMNS.employmentTypes]: 'Only these: Full Time, Part Time, Contract, Internship. Empty: any.',
  [FILTER_COLUMNS.companies]: 'Only roles at these companies, by website (commas between them). Empty: any '
    + 'company.',
};

// "Hiring: SDR, BDR" (the role titles cut to fit, without what table names can't hold).
export function hiringTableBase(roles: readonly string[], max: number): string {
  const shown = roles.map(r => r.replace(/[<>"]/g, '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const full = shown.length ? `Hiring: ${shown.join(', ')}` : 'Hiring';
  if (full.length <= max) return full;
  return `${Array.from(full).slice(0, max - 1).join('').replace(/[,\s]+$/, '')}…`;
}
