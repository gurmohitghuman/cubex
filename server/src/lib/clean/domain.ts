// Domain cleaner (pure): the registrable domain (the part a company buys) of a
// URL, host or email address, or '' when there isn't one. Separate from
// enrich-input-clean.ts's cleanDomain, which enrichment inputs keep using.
import { domainToASCII, domainToUnicode } from 'node:url';
import { parse } from 'tldts';
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { cleanTrim } from './text';

// Private suffixes count: acme.myshopify.com and acme.github.io are each
// someone's own site, not myshopify.com's or github.io's.
const OPTIONS = { allowPrivateDomains: true };
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// The host's canonical form (punycode decoded, lower case), or '' when a label
// holds anything but letters, digits and inner hyphens.
function canonicalHost(host: string): string {
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253) return '';
  if (!ascii.split('.').every(l => l.length <= 63 && LABEL.test(l))) return '';
  return domainToUnicode(ascii);
}

// "https://www.Acme.com/about?x=1" → "acme.com"; "blog.acme.co.uk" →
// "acme.co.uk"; "user@acme.com" → "acme.com". IP addresses, localhost, made-up
// endings (acme.local) and a bare suffix (co.uk) give ''.
export function cleanDomain(value: string): string {
  let s = cleanTrim(value);
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS) return '';
  s = s.replace(/^mailto:/i, '').replace(/^[<("'\s]+/, '').replace(/[>)"',;.\s]+$/, '');
  if (!s.includes('://')) s = s.slice(s.lastIndexOf('@') + 1);
  const first = parse(s, OPTIONS);
  if (!first.hostname || first.isIp) return '';
  // www., www2. are the site's front door, not part of the domain; stripped
  // first or "www.myshopify.com" would read as a shop of its own.
  const host = canonicalHost(first.hostname.replace(/^www\d*\.(?=.*\.)/, ''));
  if (!host) return '';
  const r = parse(host, OPTIONS);
  if (!r.domain || r.isIp || !(r.isIcann || r.isPrivate)) return '';
  return r.domain;
}
