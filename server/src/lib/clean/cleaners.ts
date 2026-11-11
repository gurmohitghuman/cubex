// The clean data cleaners (pure): their names, options, and the function that
// cleans one value. Every cleaner but fix_encoding tidies spaces first
// (text.ts) and returns '' for input it can't read; fix_encoding repairs text
// read with the wrong character set and returns anything it can't repair
// exactly as it came (fix-encoding.ts). None throws, and cleaning a cleaned
// value changes nothing: auto-run cleans a row again whenever its source
// changes (services/clean-follow.ts). The client mirrors the list and labels
// (client/src/lib/cleaners.ts).
import { cleanEmail } from './email';
import { cleanDomain } from './domain';
import { cleanPhone, isPhoneCountry, type PhoneFormat } from './phone';
import { cleanCompanyName, type TheCompany } from './company';
import { cleanFirstName, cleanLastName, cleanPersonName, type NameInput } from './person-name';
import { cleanLowercase, cleanTitleCase, cleanTrim } from './text';
import { fixEncoding } from './fix-encoding';

export const CLEANERS = [
  'person_name', 'first_name', 'last_name', 'company_name', 'email', 'domain', 'phone',
  'title_case', 'lowercase', 'trim', 'fix_encoding',
] as const;
export type CleanerId = typeof CLEANERS[number];
export const PHONE_FORMATS = ['national', 'international', 'e164'] as const;
export const NAME_INPUTS = ['full_name', 'first_name', 'last_name'] as const;
export const THE_COMPANY = ['strip', 'keep'] as const;
// phoneCountry: the country whose numbers bare digits are read as (ISO code, US by default).
// nameInput (first_name, last_name): what the source holds, whole names by default (person-name.ts).
// theCompany (company_name): what "The ... Company" becomes, strip by default (company.ts).
export interface CleanOptions {
  phoneFormat?: PhoneFormat; phoneCountry?: string; nameInput?: NameInput; theCompany?: TheCompany;
}

// suffix: the default clean column is "<source> (<suffix>)".
const INFO: Record<CleanerId, { suffix: string; apply: (value: string, o: CleanOptions) => string }> = {
  person_name: { suffix: 'clean', apply: v => cleanPersonName(v) },
  first_name: {
    suffix: 'first name', apply: (v, o) => cleanFirstName(v, o.nameInput === 'first_name' ? 'first_name' : 'full_name'),
  },
  last_name: {
    suffix: 'last name', apply: (v, o) => cleanLastName(v, o.nameInput === 'last_name' ? 'last_name' : 'full_name'),
  },
  company_name: { suffix: 'clean', apply: (v, o) => cleanCompanyName(v, o.theCompany ?? 'strip') },
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
  fix_encoding: { suffix: 'clean', apply: v => fixEncoding(v) },
};

export const isCleaner = (x: unknown): x is CleanerId =>
  typeof x === 'string' && (CLEANERS as readonly string[]).includes(x);

const LIST = CLEANERS.join(', ');
export const unknownCleanerMessage = (x: unknown) =>
  `Unknown cleaner${typeof x === 'string' ? ` "${x.slice(0, 40)}"` : ''}. Pick one of: ${LIST}.`;

const OPTION_KEYS = ['phoneFormat', 'phoneCountry', 'nameInput', 'theCompany'];
const given = (x: unknown) => (x ?? null) !== null;

// The phone options: its format (national by default) and its country (US by default).
function phoneOptions(cleaner: CleanerId, o: Record<string, unknown>, out: CleanOptions): string | null {
  if (!given(o.phoneFormat) && !given(o.phoneCountry)) return null;
  if (cleaner !== 'phone') return 'phone_format and phone_country are options of the phone cleaner only.';
  if (given(o.phoneFormat)) {
    if (!(PHONE_FORMATS as readonly unknown[]).includes(o.phoneFormat)) {
      return `phone_format must be one of: ${PHONE_FORMATS.join(', ')}.`;
    }
    out.phoneFormat = o.phoneFormat as PhoneFormat;
  }
  if (given(o.phoneCountry)) {
    const c = typeof o.phoneCountry === 'string' ? o.phoneCountry.trim().toUpperCase() : '';
    if (!isPhoneCountry(c)) return 'phone_country must be a two-letter country code, such as US, CA or GB.';
    out.phoneCountry = c;
  }
  return null;
}

// name_input: whole names on both name cleaners, or the cleaner's own part only.
const NAME_INPUT_OF: Partial<Record<CleanerId, readonly NameInput[]>> = {
  first_name: ['full_name', 'first_name'], last_name: ['full_name', 'last_name'],
};

function nameInputOption(cleaner: CleanerId, o: Record<string, unknown>, out: CleanOptions): string | null {
  if (!given(o.nameInput)) return null;
  const takes = NAME_INPUT_OF[cleaner];
  if (!takes) {
    return 'name_input is an option of the first_name cleaner (full_name or first_name) and the last_name cleaner '
      + '(full_name or last_name) only.';
  }
  if (!(takes as readonly unknown[]).includes(o.nameInput)) {
    return `name_input on the ${cleaner} cleaner must be ${takes.join(' or ')}.`;
  }
  out.nameInput = o.nameInput as NameInput;
  return null;
}

function theCompanyOption(cleaner: CleanerId, o: Record<string, unknown>, out: CleanOptions): string | null {
  if (!given(o.theCompany)) return null;
  if (cleaner !== 'company_name') return 'the_company is an option of the company_name cleaner only: strip or keep.';
  if (!(THE_COMPANY as readonly unknown[]).includes(o.theCompany)) return 'the_company must be strip or keep.';
  out.theCompany = o.theCompany as TheCompany;
  return null;
}

// The options a cleaner takes, checked: phone's format and country, the name
// cleaners' input, company_name's "The ... Company". Any other key is refused,
// so a typo isn't ignored, and every problem is named at once, each option by
// the name MCP and REST callers send (the app sends the camelCase keys, and
// never a wrong pair).
export function parseCleanOptions(cleaner: CleanerId, raw: unknown): { ok: CleanOptions } | { error: string } {
  if (raw === undefined || raw === null) return { ok: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'options must be an object.' };
  const o = raw as Record<string, unknown>;
  const stray = Object.keys(o).find(k => !OPTION_KEYS.includes(k));
  if (stray) return { error: `Unknown option "${stray.slice(0, 40)}".` };
  const out: CleanOptions = {};
  const problems = [phoneOptions(cleaner, o, out), nameInputOption(cleaner, o, out), theCompanyOption(cleaner, o, out)]
    .filter((p): p is string => p !== null);
  return problems.length ? { error: problems.join(' ') } : { ok: out };
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
