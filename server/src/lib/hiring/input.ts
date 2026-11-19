// What a hiring table is made from, parsed strictly (pure): the role titles
// (one search each), the country, the place, how recent and how many roles a
// search adds. The same parse serves the app, /api/v1 and MCP.
import { stripControlChars } from '../csv-safety';
import { holdsRunMarker } from '../enrich-seed';
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

export function parseHiringInput(v: unknown): HiringInput | string {
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
  const days = v.postedWithinDays === undefined ? HIRING_DEFAULT_POSTED_DAYS : v.postedWithinDays;
  if (days !== null && !whole(days, 1, HIRING_MAX_POSTED_DAYS)) {
    return `postedWithinDays must be 1 to ${HIRING_MAX_POSTED_DAYS} (or null for any time).`;
  }
  const perSearch = v.perSearch ?? HIRING_DEFAULT_PER_SEARCH;
  if (!whole(perSearch, 1, ENRICH_LIST_MAX_ITEMS)) return `perSearch must be 1 to ${ENRICH_LIST_MAX_ITEMS}.`;
  return {
    roles, country: typeof c === 'string' && c ? c.toUpperCase() : null, place: place || null,
    postedWithinDays: days as number | null, perSearch: perSearch as number,
  };
}
