// Email cleaner (pure): one address, lower case, or '' when the cell doesn't
// hold exactly one deliverable-looking address.
import { domainToASCII, domainToUnicode } from 'node:url';
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { cleanTrim } from './text';

// Dot-separated atoms of the characters an unquoted local part may use.
// Quoted local parts ("john smith"@x.com) are refused.
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/;

// The ASCII (punycode) form of a mail domain, or '' when it can't be one:
// two labels or more, letters/digits/hyphens, no IP address, a real-looking TLD.
function asciiMailDomain(domain: string): string {
  const ascii = domainToASCII(domain);
  if (!ascii || ascii.length > 253) return '';
  const labels = ascii.split('.');
  if (labels.length < 2 || !TLD.test(labels[labels.length - 1])) return '';
  return labels.every(l => l.length <= 63 && LABEL.test(l)) ? ascii : '';
}

// The address out of "John <john@x.com>", "mailto:john@x.com?subject=Hi",
// '"john@x.com",' and the like; '' for two addresses in one cell.
function extractAddress(value: string): string {
  let s = value;
  if ((s.match(/@/g) ?? []).length !== 1) return '';
  const angled = /<([^<>]*@[^<>]*)>/.exec(s);
  if (angled) s = angled[1].trim();
  s = s.replace(/^mailto:/i, '');
  // Nothing after the domain can be part of the address: "?subject=..." goes.
  const query = s.indexOf('?', s.indexOf('@'));
  if (query !== -1) s = s.slice(0, query);
  s = s.replace(/^["'()<>,;]+/, '').replace(/["'()<>,;]+$/, '');
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

// "  John.Smith@Acme.COM " → "john.smith@acme.com". Plus tags and dots are
// kept (they can matter to the mailbox). An internationalized domain stays in
// the form it was typed in (Unicode or punycode), lower-cased.
export function cleanEmail(value: string): string {
  const s = cleanTrim(value);
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS) return '';
  const address = extractAddress(s).toLowerCase();
  if (/\s/.test(address)) return '';
  const at = address.indexOf('@');
  if (at < 1) return '';
  const local = address.slice(0, at);
  const ascii = asciiMailDomain(address.slice(at + 1));
  if (local.length > 64 || !LOCAL.test(local) || !ascii) return '';
  if (local.length + 1 + ascii.length > 254) return '';
  // Typed in punycode (or plain ASCII): kept so. Otherwise the canonical
  // Unicode form, so "MÜNCHEN.DE" and a decomposed "ü" read the same.
  return `${local}@${address.slice(at + 1) === ascii ? ascii : domainToUnicode(ascii)}`;
}
