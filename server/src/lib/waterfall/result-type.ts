// What a waterfall fills, and what counts as an answer (pure). A step's value
// is an answer only when the result type reads it: an email cleanEmail
// accepts, a phone cleanPhone reads, a domain cleanDomain finds (lib/clean/),
// a LinkedIn profile or company URL, a web address, or any text that isn't a
// "nothing found" word. Anything else is no answer, so a step that returns
// text that isn't one (an AI saying "not found") never stops the waterfall.
// The value is written as the type reads it (an email in lower case, a phone
// in the chosen format).
import { cleanEmail } from '../clean/email';
import { cleanDomain } from '../clean/domain';
import { cleanPhone, isPhoneCountry, type PhoneFormat } from '../clean/phone';
import { cleanTrim } from '../clean/text';
import { holdsRunMarker } from '../run-markers';

export const RESULT_TYPES = ['email', 'phone', 'domain', 'linkedin_url', 'url', 'text'] as const;
export type ResultType = typeof RESULT_TYPES[number];
export const isResultType = (x: unknown): x is ResultType =>
  typeof x === 'string' && (RESULT_TYPES as readonly string[]).includes(x);

export interface PhoneResult { format: PhoneFormat; country: string }
export const DEFAULT_PHONE: PhoneResult = { format: 'international', country: 'US' };

export interface WaterfallInputDef { key: string; label: string }

interface Info {
  label: string;
  // What the AI step is asked for (one value, or null).
  ask: string;
  // The waterfall's inputs a new waterfall starts with (treg's input names).
  inputs: WaterfallInputDef[];
  // The answer fields an enrichment step reads by default, best first (the
  // last part of the tool's output path).
  fields: string[];
}

const NAME_INPUTS: WaterfallInputDef[] = [
  { key: 'first_name', label: 'First name' }, { key: 'last_name', label: 'Last name' },
  { key: 'full_name', label: 'Full name' },
];
const COMPANY_INPUTS: WaterfallInputDef[] = [
  { key: 'domain', label: 'Company domain' }, { key: 'company', label: 'Company name' },
];
const LINKEDIN: WaterfallInputDef = { key: 'linkedin_url', label: 'LinkedIn URL' };

export const RESULT_INFO: Record<ResultType, Info> = {
  email: {
    label: 'Work email', ask: "the person's work email address",
    inputs: [...NAME_INPUTS, ...COMPANY_INPUTS, LINKEDIN], fields: ['email', 'work_email'],
  },
  phone: {
    label: 'Phone', ask: "the person's phone number, with its country code",
    inputs: [...NAME_INPUTS, ...COMPANY_INPUTS, LINKEDIN, { key: 'email', label: 'Email' }],
    fields: ['phone', 'mobile_phone', 'phone_number'],
  },
  domain: {
    label: 'Company domain', ask: "the company's website domain, such as acme.com",
    inputs: [{ key: 'company', label: 'Company name' }, LINKEDIN, { key: 'email', label: 'Email' }],
    fields: ['domain', 'company_domain', 'website'],
  },
  linkedin_url: {
    label: 'LinkedIn URL', ask: 'the LinkedIn profile URL',
    inputs: [...NAME_INPUTS, ...COMPANY_INPUTS, { key: 'email', label: 'Email' }],
    fields: ['linkedin_url', 'linkedin'],
  },
  url: { label: 'URL', ask: 'the web address (URL)', inputs: [], fields: ['url', 'website'] },
  text: { label: 'Text', ask: 'the answer, as short plain text', inputs: [], fields: [] },
};

// Words that mean "nothing found" when a step answers in text.
const NOTHING = new Set([
  'null', 'none', 'n/a', 'na', 'nil', 'unknown', 'not found', 'not available', 'no data', 'no answer',
  'no result', 'no results', '-', '--', '?', 'undefined', '[]', '{}',
]);

function asText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'boolean') return String(raw);
  return '';
}

// "linkedin.com/in/Ada-L/?trk=x" → "https://www.linkedin.com/in/Ada-L"; company pages kept as /company/<x>.
export function cleanLinkedinUrl(value: string): string {
  const s = cleanTrim(value);
  if (!s || s.length > 500 || /\s/.test(s)) return '';
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return ''; }
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
  const m = /^\/(in|company|pub)\/([^/?#]+)/i.exec(url.pathname);
  if (!m) return '';
  let handle: string;
  try { handle = decodeURIComponent(m[2]); } catch { return ''; }
  if (!handle || /[\s<>"]/.test(handle)) return '';
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${encodeURIComponent(handle)}`;
}

// An http(s) address with a real-looking host, as given (trimmed).
export function cleanWebUrl(value: string): string {
  const s = cleanTrim(value);
  if (!s || s.length > 2_000 || /\s/.test(s)) return '';
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!/\.[a-z][a-z0-9-]*$/i.test(url.hostname)) return '';
  return url.toString();
}

// The value as the result, or '' when it isn't one.
export function normalizeResult(type: ResultType, raw: unknown, phone: PhoneResult = DEFAULT_PHONE): string {
  const text = asText(raw);
  const trimmed = cleanTrim(text);
  if (!trimmed || holdsRunMarker(trimmed) || NOTHING.has(trimmed.toLowerCase())) return '';
  switch (type) {
    case 'email': return cleanEmail(trimmed);
    case 'phone': return cleanPhone(trimmed, phone.format, isPhoneCountry(phone.country) ? phone.country : 'US');
    case 'domain': return cleanDomain(trimmed);
    case 'linkedin_url': return cleanLinkedinUrl(trimmed);
    case 'url': return cleanWebUrl(trimmed);
    default: return trimmed;
  }
}

// The output path an enrichment step reads by default: the tool's output
// whose field (its last part) the result type prefers, best first; null when
// none fits (the step must name one).
export function defaultValuePath(type: ResultType, outputs: Array<{ field: string; path: string }>): string | null {
  for (const want of RESULT_INFO[type].fields) {
    const hit = outputs.find(o => (o.field.split('.').pop() ?? '').toLowerCase() === want);
    if (hit) return hit.path;
  }
  return null;
}
