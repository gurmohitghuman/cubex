// Which company a role belongs to (pure): its domain, made plain ("https://www.
// Acme.com/jobs" and "acme.com" are one company), else its name made plain
// (case, spaces, a trailing Inc, LLC or Ltd), so a role whose provider gives no
// domain is still summed up with the others of its company.
import { cleanDomain } from '../clean/domain';

const SUFFIX = /(?:[\s,]+(?:inc|incorporated|llc|l\.l\.c|ltd|limited))\.?$/i;

// "Acme, Inc." → "acme"; '' for no name.
export function plainCompanyName(name: string): string {
  let s = name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
  for (let before = ''; before !== s;) {
    before = s;
    s = s.replace(SUFFIX, '').replace(/[.,;:\s]+$/, '');
  }
  return s;
}

// byName: no domain, so the name is the key ('name:' first, never a domain's look).
export interface CompanyKey { key: string; domain: string; byName: boolean }

export function companyKey(domain: string, name: string): CompanyKey | null {
  const d = domain ? cleanDomain(domain) : '';
  if (d) return { key: d, domain: d, byName: false };
  const n = plainCompanyName(name);
  return n ? { key: `name:${n}`, domain: '', byName: true } : null;
}
