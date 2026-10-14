// The clean data cleaners (pure): their names, options, and the function that
// cleans one value. Every cleaner tidies spaces first (text.ts), returns ''
// for input it can't read and never throws, and cleaning a cleaned value
// changes nothing: auto-run cleans a row again whenever its source changes
// (services/clean-follow.ts). The client mirrors the list and labels
// (client/src/lib/cleaners.ts).
import { cleanEmail } from './email';
import { cleanDomain } from './domain';
import { cleanPhone, isPhoneCountry, type PhoneFormat } from './phone';
import { cleanCompanyName } from './company';
import { cleanFirstName, cleanLastName, cleanPersonName } from './person-name';
import { cleanLowercase, cleanTitleCase, cleanTrim } from './text';

export const CLEANERS = [
  'person_name', 'first_name', 'last_name', 'company_name', 'email', 'domain', 'phone',
  'title_case', 'lowercase', 'trim',
] as const;
export type CleanerId = typeof CLEANERS[number];
export const PHONE_FORMATS = ['national', 'international', 'e164'] as const;
// phoneCountry: the country whose numbers bare digits are read as (ISO code, US by default).
export interface CleanOptions { phoneFormat?: PhoneFormat; phoneCountry?: string }

// suffix: the default clean column is "<source> (<suffix>)".
const INFO: Record<CleanerId, { suffix: string; apply: (value: string, o: CleanOptions) => string }> = {
  person_name: { suffix: 'clean', apply: v => cleanPersonName(v) },
  first_name: { suffix: 'first name', apply: v => cleanFirstName(v) },
  last_name: { suffix: 'last name', apply: v => cleanLastName(v) },
  company_name: { suffix: 'clean', apply: v => cleanCompanyName(v) },
  email: { suffix: 'clean', apply: v => cleanEmail(v) },
  domain: { suffix: 'domain', apply: v => cleanDomain(v) },
  phone: {
    suffix: 'clean',
    apply: (v, o) =>
      cleanPhone(v, o.phoneFormat ?? 'national', isPhoneCountry(o.phoneCountry) ? o.phoneCountry : 'US'),
  },
  title_case: { suffix: 'clean', apply: v => cleanTitleCase(v) },
  lowercase: { suffix: 'clean', apply: v => cleanLowercase(v) },
  trim: { suffix: 'clean', apply: v => cleanTrim(v) },
};

export const isCleaner = (x: unknown): x is CleanerId =>
  typeof x === 'string' && (CLEANERS as readonly string[]).includes(x);

const LIST = CLEANERS.join(', ');
export const unknownCleanerMessage = (x: unknown) =>
  `Unknown cleaner${typeof x === 'string' ? ` "${x.slice(0, 40)}"` : ''}. Pick one of: ${LIST}.`;

// The options a cleaner takes, checked. Only phone has any (its format,
// national by default, and its country, US by default); any other key is
// refused, so a typo isn't ignored.
export function parseCleanOptions(cleaner: CleanerId, raw: unknown): { ok: CleanOptions } | { error: string } {
  if (raw === undefined || raw === null) return { ok: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'options must be an object.' };
  const o = raw as Record<string, unknown>;
  const stray = Object.keys(o).find(k => k !== 'phoneFormat' && k !== 'phoneCountry');
  if (stray) return { error: `Unknown option "${stray.slice(0, 40)}".` };
  const given = (o.phoneFormat ?? null) !== null || (o.phoneCountry ?? null) !== null;
  if (!given) return { ok: {} };
  if (cleaner !== 'phone') return { error: 'phoneFormat and phoneCountry are options of the phone cleaner only.' };
  const out: CleanOptions = {};
  if ((o.phoneFormat ?? null) !== null) {
    if (!(PHONE_FORMATS as readonly unknown[]).includes(o.phoneFormat)) {
      return { error: `phoneFormat must be one of: ${PHONE_FORMATS.join(', ')}.` };
    }
    out.phoneFormat = o.phoneFormat as PhoneFormat;
  }
  if ((o.phoneCountry ?? null) !== null) {
    const c = typeof o.phoneCountry === 'string' ? o.phoneCountry.trim().toUpperCase() : '';
    if (!isPhoneCountry(c)) return { error: 'phoneCountry must be a two-letter country code, such as US, CA or GB.' };
    out.phoneCountry = c;
  }
  return { ok: out };
}

export function cleanerFn(cleaner: CleanerId, options: CleanOptions): (value: string) => string {
  const { apply } = INFO[cleaner];
  return value => {
    try { return apply(value, options); } catch { return ''; }
  };
}

// For a saved record (clean_columns.cleaner + options): null for a cleaner
// this version doesn't know.
export function cleanerForRecord(cleaner: string, optionsJson: string): ((value: string) => string) | null {
  if (!isCleaner(cleaner)) return null;
  let raw: unknown = {};
  try { raw = JSON.parse(optionsJson); } catch { /* defaults */ }
  const options = parseCleanOptions(cleaner, raw);
  return cleanerFn(cleaner, 'ok' in options ? options.ok : {});
}

export const defaultCleanColumnName = (cleaner: CleanerId, source: string): string =>
  `${source} (${INFO[cleaner].suffix})`;
