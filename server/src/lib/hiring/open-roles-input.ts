// Open roles at the companies on a person's own sheet (pure): what is asked, parsed strictly, and the run that
// searches each company row (services/open-roles.ts). The run is hirebase's job index called directly, as a hiring
// table with More filters calls it: the row's website, cleaned to its domain, as the one company
// (company_domains); the roles asked as its titles; the country, place and how recent as fixed values. A row whose
// website cleans to nothing isn't searched (lib/enrich-request.ts): with no company, the index would answer roles at
// any company. Each role found becomes a row in the Open roles sheet, kept (a role found again is not added again),
// with the company row's own website cell copied into its Domain, so the lookup on the company sheet matches it
// exactly, whatever form the cells are in; and First seen the run's day, set by each start.
import { stripControlChars } from '../csv-safety';
import { digitsAsNumber } from '../digits-text';
import { holdsRunMarker } from '../enrich-seed';
import { ENRICH_LIST_MAX_ITEMS, HIRING_DEFAULT_POSTED_DAYS, HIRING_MAX_PLACE_CHARS, HIRING_MAX_POSTED_DAYS } from
  '../constants';
import type { EnrichRunInput, InputBinding } from '../enrich-run-input';
import { countryName, directRoleTitle } from './filters';
import { parseRoles, postedDaysRefusal, perSearchRefusal } from './input';
import { jobFields } from './job-fields';
import { HIRING_DIRECT_PROVIDER, HIRING_DIRECT_TOOL_ID, OPEN_ROLES, ROLE_COLUMNS } from './names';
import { DIRECT_ITEMS_PATH } from './search-input';

// Roles a company row adds at most, when the asker doesn't say: a company hiring for more than this many of the
// roles asked is already a clear signal, and each role found is paid for.
export const OPEN_ROLES_DEFAULT_PER_COMPANY = 10;

export interface OpenRolesOptions {
  websiteColumn: string;
  roles: string[];                  // as the job index takes them: one title each
  country: string | null;           // ISO alpha-2, or null: any country
  place: string | null;
  postedWithinDays: number | null;  // null: any time
  perCompany: number;
}

// The Open roles sheet's columns: a hiring table's Roles columns but Search (one run asks every role).
export const OPEN_ROLE_COLUMNS: string[] = Object.values(ROLE_COLUMNS).filter(c => c !== ROLE_COLUMNS.search);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? stripControlChars(v).replace(/\s+/g, ' ').trim() : '');
const whole = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;

// The names the asker sends (the app camelCase, /api/v1 and MCP snake_case), for the refusals to use.
const NAMES = {
  camel: { website: 'websiteColumn', days: 'postedWithinDays', perCompany: 'perCompany' },
  snake: { website: 'website_column', days: 'posted_within_days', perCompany: 'per_company' },
};

// A title as the job index takes it: one title, never a word to leave out, nor a column's {{name}}.
const titleOf = (role: string): string => directRoleTitle(role).replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();

// The request's fields, read by the asker's names (camelCase in, as the routes pass them).
export function parseOpenRoles(v: unknown, names: keyof typeof NAMES = 'camel'): OpenRolesOptions | string {
  const n = NAMES[names];
  if (!isObj(v)) return 'Send the website column and the role titles to look for.';
  const website = typeof v.websiteColumn === 'string' ? v.websiteColumn.trim() : '';
  if (!website) return `${n.website} must name the column holding each company's website.`;
  const raw = parseRoles(v.roles);
  if (typeof raw === 'string') return raw;
  const roles = parseRoles(raw.map(titleOf));
  if (typeof roles === 'string') return roles;
  const c = v.country ?? null;
  if (c !== null && c !== '' && (typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c))) {
    return 'country must be a two-letter country code, such as US or GB (or empty for any country).';
  }
  const place = text(v.place);
  if (place.length > HIRING_MAX_PLACE_CHARS || holdsRunMarker(place) || /[{}]/.test(place)) {
    return `place is plain text of at most ${HIRING_MAX_PLACE_CHARS} characters, such as "Texas".`;
  }
  // Whole numbers, also as digits ("30"), as MCP's lenientInt takes them.
  const days = v.postedWithinDays === undefined ? HIRING_DEFAULT_POSTED_DAYS : digitsAsNumber(v.postedWithinDays);
  if (days !== null && !whole(days, 1, HIRING_MAX_POSTED_DAYS)) return postedDaysRefusal(n.days);
  const perCompany = digitsAsNumber(v.perCompany ?? OPEN_ROLES_DEFAULT_PER_COMPANY);
  if (!whole(perCompany, 1, ENRICH_LIST_MAX_ITEMS)) return perSearchRefusal(n.perCompany);
  return {
    websiteColumn: website, roles, country: typeof c === 'string' && c ? c.toUpperCase() : null, place: place || null,
    postedWithinDays: days as number | null, perCompany: perCompany as number,
  };
}

const tok = (column: string) => `{{${column}}}`;

// "United States" → "US": the run sends the country by name (countryName); the app asks for its code. Every
// two-letter code's name, worked out once.
let codes: Map<string, string> | null = null;
function countryCodeOf(name: string): string | null {
  if (!codes) {
    codes = new Map();
    const A = 'A'.charCodeAt(0);
    for (let i = 0; i < 26 * 26; i++) {
      const code = String.fromCharCode(A + Math.floor(i / 26), A + (i % 26));
      const n = countryName(code);
      if (n !== code && !codes.has(n.toLowerCase())) codes.set(n.toLowerCase(), code);
    }
  }
  return codes.get(name.toLowerCase()) ?? null;
}

const parsedJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};

// What a sheet's search column was last run with, read back from its inputs (as openRolesInput wrote them), for the
// app to show again; null when they aren't ours.
export function openRolesOf(templates: Record<string, string>, perCompany: number): OpenRolesOptions | null {
  const domains = parsedJson(templates.company_domains);
  const website = Array.isArray(domains) && typeof domains[0] === 'string' ? /^\{\{(.+)\}\}$/.exec(domains[0]) : null;
  const titles = parsedJson(templates.job_titles);
  if (!website || !Array.isArray(titles) || !titles.every(t => typeof t === 'string')) return null;
  const geo = parsedJson(templates.geo_locations);
  const where = Array.isArray(geo) && geo[0] && typeof geo[0] === 'object' ? geo[0] as Record<string, unknown> : {};
  const days = Number(templates.days_ago);
  return {
    websiteColumn: website[1], roles: titles as string[],
    country: typeof where.country === 'string' ? countryCodeOf(where.country) : null,
    place: typeof where.city === 'string' && where.city ? where.city : null,
    postedWithinDays: Number.isSafeInteger(days) && days > 0 ? days : null, perCompany,
  };
}

// The job index's inputs: the row's website as the one company; the rest fixed. A filter not asked isn't sent.
function searchInputs(o: OpenRolesOptions): Record<string, InputBinding> {
  const where: Record<string, string> = {
    ...(o.country ? { country: countryName(o.country) } : {}), ...(o.place ? { city: o.place } : {}),
  };
  return {
    company_domains: { value: JSON.stringify([tok(o.websiteColumn)]) },
    job_titles: { value: JSON.stringify(o.roles) },
    ...(Object.keys(where).length ? { geo_locations: { value: JSON.stringify([where]) } } : {}),
    ...(o.postedWithinDays !== null ? { days_ago: { value: String(o.postedWithinDays) } } : {}),
  };
}

// The run on the company sheet. rolesSheetId: the Open roles sheet (made before the run starts). firstSeen: the
// run's day. existing: the column is there already (its rows searched again).
export function openRolesInput(o: OpenRolesOptions, rolesSheetId: string, firstSeen: string, existing: boolean):
  EnrichRunInput {
  const f = jobFields(HIRING_DIRECT_PROVIDER);
  return {
    toolId: HIRING_DIRECT_TOOL_ID, preset: null, columnName: OPEN_ROLES.status, continueColumn: existing,
    inputs: searchInputs(o), cleanDomains: true, providerOrder: [], skipProviders: [], stopAtFirst: false,
    email: null, outputs: [], rows: { mode: 'all', status: 'any', test: null, rowIndexes: null },
    conditions: [], runIf: `${tok(o.websiteColumn)} is not empty`, maxCostPerRowUsd: null, spendLimitUsd: null,
    concurrency: null, fresh: true, rowGeneration: null,
    list: {
      dest: { sheetId: rolesSheetId }, provider: null, maxItems: o.perCompany, itemsPath: DIRECT_ITEMS_PATH,
      // The company's Domain is its own website cell (copied below), not the index's.
      fields: f.fields.filter(x => x.columnName !== ROLE_COLUMNS.domain),
      copy: [
        { from: o.websiteColumn, to: ROLE_COLUMNS.domain }, { from: '', to: ROLE_COLUMNS.firstSeen, value: firstSeen },
      ],
      dedupePath: f.dedupePath, dedupeAlso: f.dedupeAlso, keep: true,
    },
  };
}
