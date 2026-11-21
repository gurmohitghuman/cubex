// What a hiring table is made from, parsed strictly (pure): the role titles
// (one search each), the country, the place, how recent, how many roles a
// search adds and its More filters (lib/hiring/filters.ts). The same parse
// serves the app, /api/v1 and MCP.
import { stripControlChars } from '../csv-safety';
import { holdsRunMarker } from '../enrich-seed';
import { digitsAsNumber } from '../digits-text';
import { usdLimitOf } from '../cost-ceiling';
import { directRoleTitle, parseHiringFilters, type HiringFilters } from './filters';
import {
  ENRICH_LIST_MAX_ITEMS, HIRING_DEFAULT_PER_SEARCH, HIRING_DEFAULT_POSTED_DAYS, HIRING_MAX_PLACE_CHARS,
  HIRING_MAX_POSTED_DAYS, HIRING_MAX_ROLE_CHARS, HIRING_MAX_ROLES,
} from '../constants';

export interface HiringInput {
  roles: string[];
  country: string | null;           // ISO alpha-2, or null: any country
  place: string | null;
  postedWithinDays: number | null;  // null: any time
  perSearch: number;
  filters: HiringFilters | null;    // null: none (the routed search)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? stripControlChars(v).replace(/\s+/g, ' ').trim() : '');

function parseRoles(v: unknown): string[] | string {
  const raw = typeof v === 'string' ? v.split(/\r?\n/) : v;
  if (!Array.isArray(raw)) return 'roles must list the role titles to search for, such as "SDR".';
  const out: string[] = [];
  for (const r of raw) {
    const s = text(r);
    if (!s) continue;
    if (s.length > HIRING_MAX_ROLE_CHARS || holdsRunMarker(s)) {
      return `Each role title is plain text of at most ${HIRING_MAX_ROLE_CHARS} characters.`;
    }
    if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length === 0) return 'Add at least one role title, such as "Sales Development Representative".';
  if (out.length > HIRING_MAX_ROLES) {
    return `Start with at most ${HIRING_MAX_ROLES} role titles (you can add rows later).`;
  }
  return out;
}

const whole = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;

// The names the asker sends (the app camelCase, /api/v1 and MCP snake_case), for the refusals to use.
const NAMES = {
  camel: { days: 'postedWithinDays', perSearch: 'perSearch' },
  snake: { days: 'posted_within_days', perSearch: 'per_search' },
};
export const postedDaysRefusal = (name: string) =>
  `${name} must be 1 to ${HIRING_MAX_POSTED_DAYS} (or null for any time).`;
export const perSearchRefusal = (name: string) => `${name} must be 1 to ${ENRICH_LIST_MAX_ITEMS}.`;

// The most a check may spend (dollars, the high end its estimate showed), or why it can't start without one.
export function checkMostOf(raw: unknown, name: string): { value: number } | { error: string } {
  const most = usdLimitOf(raw, name);
  if ('error' in most) return most;
  return most.value === null ? { error: `A check needs ${name}: the most it may cost in dollars, the high end `
    + 'of its estimate (ask for the estimate first). Nothing was searched.' } : { value: most.value };
}

export function parseHiringInput(v: unknown, names: keyof typeof NAMES = 'camel'): HiringInput | string {
  const n = NAMES[names];
  if (!isObj(v)) return 'Send the role titles to search for.';
  const roles = parseRoles(v.roles);
  if (typeof roles === 'string') return roles;
  const c = v.country ?? null;
  if (c !== null && c !== '' && (typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c))) {
    return 'country must be a two-letter country code, such as US or GB (or empty for any country).';
  }
  const place = text(v.place);
  if (place.length > HIRING_MAX_PLACE_CHARS || holdsRunMarker(place)) {
    return `place is plain text of at most ${HIRING_MAX_PLACE_CHARS} characters, such as "Texas".`;
  }
  // Whole numbers, also as digits ("30"), as MCP's lenientInt takes them.
  const days = v.postedWithinDays === undefined ? HIRING_DEFAULT_POSTED_DAYS : digitsAsNumber(v.postedWithinDays);
  if (days !== null && !whole(days, 1, HIRING_MAX_POSTED_DAYS)) return postedDaysRefusal(n.days);
  const perSearch = digitsAsNumber(v.perSearch ?? HIRING_DEFAULT_PER_SEARCH);
  if (!whole(perSearch, 1, ENRICH_LIST_MAX_ITEMS)) return perSearchRefusal(n.perSearch);
  const filters = parseHiringFilters(v, names);
  if (typeof filters === 'string') return filters;
  // With filters, each title as the job index takes it (one title, not a word to leave out).
  const titles = filters ? parseRoles(roles.map(directRoleTitle)) : roles;
  if (typeof titles === 'string') return titles;
  return {
    roles: titles, country: typeof c === 'string' && c ? c.toUpperCase() : null, place: place || null,
    postedWithinDays: days as number | null, perSearch: perSearch as number, filters,
  };
}
