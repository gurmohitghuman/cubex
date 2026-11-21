// A hiring table's search as a run start takes it (pure): every search row,
// the roles into Roles (kept, never replaced), the role title searched copied
// into each, and First seen, the check's day (set by each check; empty until
// the first). New postings come every day: every search asks again (no reuse,
// nor treg's archive).
//
// Without More filters it runs treg's routed job search on the provider its
// plan lists first. With them it runs the job index that takes them
// (hirebase.jobs.search) directly, each filter read from its Searches column:
// a list from a cell's comma list, "-" before each word to leave out, and the
// place as the index takes it (lib/enrich-template.ts fills these). A row with
// no role title isn't searched (the index would answer any role).
import type { EnrichRunInput, InputBinding } from '../enrich-run-input';
import { jobFields } from './job-fields';
import {
  FILTER_COLUMNS, HIRING_DIRECT_PROVIDER, HIRING_DIRECT_TOOL_ID, HIRING_TOOL_ID, ROLE_COLUMNS, SEARCH_COLUMNS,
} from './names';

// The routed search's inputs: one column each.
export const ROUTED_INPUTS = {
  title: SEARCH_COLUMNS.role, country: SEARCH_COLUMNS.country, location: SEARCH_COLUMNS.place,
  posted_within_days: SEARCH_COLUMNS.days,
} as const;

const tok = (column: string) => `{{${column}}}`;
// The direct search's inputs: a column, or a template laid out as JSON.
const DIRECT_INPUTS: Record<string, InputBinding> = {
  job_titles: { value: JSON.stringify([tok(SEARCH_COLUMNS.role), `-${tok(FILTER_COLUMNS.leaveOutTitleWords)}`]) },
  keywords: {
    value: JSON.stringify([tok(FILTER_COLUMNS.descriptionWords), `-${tok(FILTER_COLUMNS.leaveOutDescriptionWords)}`]),
  },
  geo_locations: { value: JSON.stringify([{ country: tok(SEARCH_COLUMNS.country), city: tok(SEARCH_COLUMNS.place) }]) },
  days_ago: { column: SEARCH_COLUMNS.days },
  experience_levels: { column: FILTER_COLUMNS.seniority },
  job_types: { column: FILTER_COLUMNS.employmentTypes },
  company_domains: { column: FILTER_COLUMNS.companies },
};

// The direct search's own rows are in its answer's "jobs".
export const DIRECT_ITEMS_PATH = '$.jobs';
export const DIRECT_RUN_IF = `${tok(SEARCH_COLUMNS.role)} is not empty`;

// The Searches columns a search reads, in order ("Roles found" comes after them).
export const searchColumns = (direct: boolean): string[] => [
  SEARCH_COLUMNS.role, SEARCH_COLUMNS.country, SEARCH_COLUMNS.place, SEARCH_COLUMNS.days,
  ...(direct ? Object.values(FILTER_COLUMNS) : []),
];

// provider: the routed search's (null with filters: the direct search is one provider's own).
export function searchInput(direct: boolean, provider: string | null, perSearch: number, rolesSheetId: string):
  EnrichRunInput {
  const f = jobFields(direct ? HIRING_DIRECT_PROVIDER : provider);
  return {
    toolId: direct ? HIRING_DIRECT_TOOL_ID : HIRING_TOOL_ID, preset: null, columnName: SEARCH_COLUMNS.status,
    continueColumn: false,
    inputs: direct ? { ...DIRECT_INPUTS }
      : Object.fromEntries(Object.entries(ROUTED_INPUTS).map(([k, column]) => [k, { column }])),
    cleanDomains: false, providerOrder: [], skipProviders: [], stopAtFirst: false, email: null, outputs: [],
    rows: { mode: 'all', status: 'any', test: null, rowIndexes: null },
    conditions: [], runIf: direct ? DIRECT_RUN_IF : null, maxCostPerRowUsd: null, spendLimitUsd: null,
    concurrency: null, fresh: true, rowGeneration: null,
    list: {
      dest: { sheetId: rolesSheetId }, provider: direct ? null : provider, maxItems: perSearch, fields: f.fields,
      copy: [
        { from: SEARCH_COLUMNS.role, to: ROLE_COLUMNS.search }, { from: '', to: ROLE_COLUMNS.firstSeen, value: '' },
      ],
      dedupePath: f.dedupePath, dedupeAlso: f.dedupeAlso, keep: true,
      ...(direct ? { itemsPath: DIRECT_ITEMS_PATH } : {}),
    },
  };
}
