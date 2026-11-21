// A hiring table's More filters, parsed strictly (pure). Each search sends them
// to the job index with its title, place and how recent. Description words
// put the roles that mention them first (they rank roles, they never leave
// one out); every other filter leaves roles out. Only one job index takes
// them (hirebase), so a table made with any of them searches it directly
// (services/hiring-create.ts). The same parse serves the app, /api/v1 and MCP.
import { stripControlChars } from '../csv-safety';
import { holdsRunMarker } from '../enrich-seed';
import { cleanDomain } from '../enrich-input-clean';
import { HIRING_MAX_COMPANIES, HIRING_MAX_FILTER_WORDS, HIRING_MAX_WORD_CHARS } from '../constants';

// The job index's own labels, sent as written.
export const SENIORITY_LEVELS = [
  'Entry-Level', 'Junior / Associate', 'Mid-Level', 'Senior', 'Principal / Staff / Lead', 'Executive',
] as const;
export const EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Internship'] as const;

export interface HiringFilters {
  descriptionWords: string[];          // roles that mention these come first
  leaveOutDescriptionWords: string[];  // roles whose description mentions one are left out
  leaveOutTitleWords: string[];        // roles whose title has one are left out
  seniority: string[];                 // SENIORITY_LEVELS
  employmentTypes: string[];           // EMPLOYMENT_TYPES
  companies: string[];                 // websites: only roles at these companies
}
export type FilterKey = keyof HiringFilters;
export const FILTER_KEYS: FilterKey[] = [
  'descriptionWords', 'leaveOutDescriptionWords', 'leaveOutTitleWords', 'seniority', 'employmentTypes', 'companies',
];

// The names the asker sends: the app camelCase, /api/v1 and MCP snake_case.
export const FILTER_NAMES: Record<'camel' | 'snake', Record<FilterKey, string>> = {
  camel: Object.fromEntries(FILTER_KEYS.map(k => [k, k])) as Record<FilterKey, string>,
  snake: {
    descriptionWords: 'description_words', leaveOutDescriptionWords: 'leave_out_description_words',
    leaveOutTitleWords: 'leave_out_title_words', seniority: 'seniority', employmentTypes: 'employment_types',
    companies: 'companies',
  },
};

const text = (v: string): string => stripControlChars(v).replace(/\s+/g, ' ').trim();
const keyOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// A list, or text with commas or lines: its items, each trimmed, once each (case ignored).
function itemsOf(v: unknown, name: string): string[] | string {
  if (v === undefined || v === null) return [];
  const raw = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string')) {
    return `${name} must be a list of words, such as ["kubernetes"].`;
  }
  const out: string[] = [];
  for (const item of (raw as string[]).flatMap(x => x.split(/[,\r\n]/)).map(text)) {
    if (item && !out.some(x => x.toLowerCase() === item.toLowerCase())) out.push(item);
  }
  return out;
}

function wordsOf(v: unknown, name: string): string[] | string {
  const items = itemsOf(v, name);
  if (typeof items === 'string') return items;
  if (items.length > HIRING_MAX_FILTER_WORDS) return `${name} takes at most ${HIRING_MAX_FILTER_WORDS} words.`;
  if (items.some(w => w.length > HIRING_MAX_WORD_CHARS || holdsRunMarker(w))) {
    return `Each word in ${name} is plain text of at most ${HIRING_MAX_WORD_CHARS} characters.`;
  }
  return items;
}

// "-word" → "word": a list of words to leave out takes them without the "-".
const undashed = (words: string[]) => words.map(w => w.replace(/^[-\s]+/, '')).filter(Boolean);

// One of the job index's labels, matched loosely ("full-time"; with parts, a
// level by any word of it: "entry", "staff").
function labelsOf(v: unknown, name: string, labels: readonly string[], also: Record<string, string>,
  parts = false): string[] | string {
  const items = itemsOf(v, name);
  if (typeof items === 'string') return items;
  const known = new Map<string, string>(Object.entries(also));
  for (const l of labels) {
    known.set(keyOf(l), l);
    if (parts) for (const part of l.split(/[\s/-]+/)) if (keyOf(part) !== 'level') known.set(keyOf(part), l);
  }
  const out: string[] = [];
  for (const item of items) {
    const label = known.get(keyOf(item));
    if (!label) return `${name} takes ${labels.join(', ')} (got "${item.slice(0, 40)}").`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function companiesOf(v: unknown, name: string): string[] | string {
  const items = itemsOf(v, name);
  if (typeof items === 'string') return items;
  const out: string[] = [];
  for (const item of items) {
    const d = cleanDomain(item);
    if (!DOMAIN_RE.test(d)) {
      return `Each company in ${name} is its website, such as ramp.com (got "${item.slice(0, 40)}").`;
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > HIRING_MAX_COMPANIES) return `${name} takes at most ${HIRING_MAX_COMPANIES} companies.`;
  return out;
}

// The filters sent (null: none, so the table searches as one without them), or why they can't be taken.
export function parseHiringFilters(v: Record<string, unknown>, names: 'camel' | 'snake'):
  HiringFilters | null | string {
  const n = FILTER_NAMES[names];
  const words = wordsOf(v[n.descriptionWords], n.descriptionWords);
  if (typeof words === 'string') return words;
  const wordsOut = wordsOf(v[n.leaveOutDescriptionWords], n.leaveOutDescriptionWords);
  if (typeof wordsOut === 'string') return wordsOut;
  const titleOut = wordsOf(v[n.leaveOutTitleWords], n.leaveOutTitleWords);
  if (typeof titleOut === 'string') return titleOut;
  const seniority = labelsOf(v[n.seniority], n.seniority, SENIORITY_LEVELS, {}, true);
  if (typeof seniority === 'string') return seniority;
  const employmentTypes = labelsOf(v[n.employmentTypes], n.employmentTypes, EMPLOYMENT_TYPES,
    { intern: 'Internship', contractor: 'Contract' });
  if (typeof employmentTypes === 'string') return employmentTypes;
  const companies = companiesOf(v[n.companies], n.companies);
  if (typeof companies === 'string') return companies;
  // A description word written "-word" leaves roles out, as the job index reads it.
  const f: HiringFilters = {
    descriptionWords: words.filter(w => !w.startsWith('-')),
    leaveOutDescriptionWords: undashed([...wordsOut, ...words.filter(w => w.startsWith('-'))])
      .filter((w, i, all) => all.findIndex(x => x.toLowerCase() === w.toLowerCase()) === i),
    leaveOutTitleWords: undashed(titleOut), seniority, employmentTypes, companies,
  };
  if (f.leaveOutDescriptionWords.length > HIRING_MAX_FILTER_WORDS) {
    return `${n.leaveOutDescriptionWords} takes at most ${HIRING_MAX_FILTER_WORDS} words.`;
  }
  return FILTER_KEYS.some(k => f[k].length > 0) ? f : null;
}

// A role title as the job index takes it with these filters: one title (a comma
// would make it two) that isn't a word to leave out (a leading "-").
export const directRoleTitle = (role: string): string => role.replace(/,/g, ' ').replace(/^[-\s]+/, '')
  .replace(/\s+/g, ' ').trim();

// "US" → "United States": the job index takes a country by name. Anything else is sent as written.
export function countryName(country: string): string {
  if (!/^[A-Za-z]{2}$/.test(country)) return country;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country.toUpperCase()) ?? country;
  } catch { return country; }
}
