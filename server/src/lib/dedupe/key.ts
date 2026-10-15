// The key a row is matched on when removing duplicates (pure). Each key
// column is read the way its match says: text ignores upper/lower case and
// extra spaces; email, domain, phone, company and person name go through the
// clean data cleaners (lib/clean/), so "https://www.acme.com/x" and
// "jo@acme.com" match as a domain. A cell holding a run's status (⏳, ❌, ⏭️,
// ➕) reads as empty: those are Cubex's words, not data, and 50,000 rows of
// "⏭️ Not found" are not one person. A row missing a value in ANY key column
// (empty, or unreadable to its cleaner) is never a duplicate: matching on
// Email and First name, two people named Kai without an email are not one.
// Where a cleaner drops something that tells people apart, the key keeps it:
// a phone extension, Jr or Sr, the page on a shared site (shared-domains.ts).
import { createHash } from 'node:crypto';
import { cleanTrim } from '../clean/text';
import { cleanEmail } from '../clean/email';
import { cleanDomain } from '../clean/domain';
import { cleanPhone, isPhoneCountry } from '../clean/phone';
import { cleanCompanyName } from '../clean/company';
import { cleanPersonName } from '../clean/person-name';
import { holdsRunMarker } from '../run-markers';
import { DEDUPE_KEY_HASH_CHARS, DEDUPE_PHONE_MIN_DIGITS } from '../constants-dedupe';
import { FREE_EMAIL_DOMAINS, SHARED_SITE_DOMAINS } from './shared-domains';

export const DEDUPE_MATCHES = ['text', 'email', 'domain', 'phone', 'company', 'person_name'] as const;
export type DedupeMatch = typeof DEDUPE_MATCHES[number];
export const DEDUPE_KEEPS = ['first', 'last', 'most_complete'] as const;
export type DedupeKeep = typeof DEDUPE_KEEPS[number];
// country: how a phone key reads bare digits (ISO code, US by default).
export interface DedupeKey { column: string; match: DedupeMatch; country?: string }

export const isDedupeMatch = (x: unknown): x is DedupeMatch =>
  typeof x === 'string' && (DEDUPE_MATCHES as readonly string[]).includes(x);
export const isDedupeKeep = (x: unknown): x is DedupeKeep =>
  typeof x === 'string' && (DEDUPE_KEEPS as readonly string[]).includes(x);

const text = (v: string): string => cleanTrim(v).normalize('NFC').toLowerCase();

// Only the characters a phone number is written with: a value like
// "2.12555E+09" (a spreadsheet's float that lost digits) never matches by digits.
const PHONE_CHARS = /^[\d\s()+\-./]+$/;
// An extension at the end ("ext. 12", "x34", "#7"): people behind one switchboard aren't one person.
const PHONE_EXT = /\s*(?:ext\.?|extension|x|#)\s*(\d{1,7})$/i;

// A phone number as E.164, plus its extension. One the phone metadata can't
// place ("555-0100") still matches the same digits written another way.
function phone(v: string, country: string): string {
  const s = cleanTrim(v);
  const ext = PHONE_EXT.exec(s);
  const main = ext ? s.slice(0, ext.index) : s;
  const tail = ext ? `x${ext[1]}` : '';
  const e164 = cleanPhone(main, 'e164', isPhoneCountry(country) ? country : 'US');
  if (e164) return e164 + tail;
  if (!PHONE_CHARS.test(main)) return '';
  const digits = main.replace(/\D/g, '');
  return digits.length >= DEDUPE_PHONE_MIN_DIGITS ? digits + tail : '';
}

// A website's or an email's domain. An address at a free email provider
// never matches by domain; on a shared site the key is the page: its host
// (without www., m. or mobile.), path and query. The site itself, or an
// address at it, never matches.
function domain(v: string): string {
  const d = cleanDomain(v);
  if (!d || FREE_EMAIL_DOMAINS.has(d)) return '';
  if (!SHARED_SITE_DOMAINS.has(d)) return d;
  const s = cleanTrim(v).replace(/^mailto:/i, '');
  if (/^[^/@\s]+@[^/@\s]+$/.test(s)) return '';
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return ''; }
  const host = url.hostname.toLowerCase().replace(/^(?:www\d*|m|mobile)\./, '');
  const page = `${host}${url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')}${url.search}`.toLowerCase();
  return page === d ? '' : page;
}

// Jr, Sr, II, III or IV in a name: the full-name cleaner drops them, but a
// father and son are two people.
const GENERATION = /(?:^|[\s,])(jr|junior|sr|senior|ii|iii|iv)\.?(?=$|[\s,])/i;
const GENERATION_OF: Record<string, string> = { junior: 'jr', senior: 'sr' };

// The name without its generation, cleaned, then the generation in one spelling.
function personName(v: string): string {
  const m = GENERATION.exec(v);
  const rest = m ? `${v.slice(0, m.index)} ${v.slice(m.index + m[0].length)}` : v;
  const name = text(cleanPersonName(rest));
  const gen = m?.[1].toLowerCase();
  return name && gen ? `${name} ${GENERATION_OF[gen] ?? gen}` : name;
}

const MATCHERS: Record<DedupeMatch, (v: string, k: DedupeKey) => string> = {
  text: v => text(v),
  email: v => cleanEmail(v),
  domain: v => domain(v),
  phone: (v, k) => phone(v, k.country ?? 'US'),
  company: v => text(cleanCompanyName(v)),
  person_name: v => personName(v),
};

// What one key cell matches on: '' for an empty cell, a run's status, or a
// value its cleaner can't read. `cell` is the cell as SQLite's json_extract
// gives it (text, a number, or null).
export function keyPart(key: DedupeKey, cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  const v = typeof cell === 'string' ? cell : String(cell);
  if (v === '' || holdsRunMarker(v)) return '';
  try { return MATCHERS[key.match](v.normalize('NFC'), key); } catch { return ''; }
}

// A row's key from its parts, or null when any part is empty (never a
// duplicate). Parts are joined so no two different lists give one key, and a
// long key is kept as its hash; the first character keeps the two apart.
export function rowKey(parts: string[]): string | null {
  if (parts.some(p => p === '')) return null;
  const joined = parts.length === 1 ? parts[0] : JSON.stringify(parts);
  return joined.length > DEDUPE_KEY_HASH_CHARS
    ? `#${createHash('sha256').update(joined).digest('base64')}`
    : `=${joined}`;
}
