// Cookie-session writes from another site are refused. SameSite=Strict (lib/cookie.ts) ignores ports, so a page of
// another app on the same host (another port) counts as same-site: the browser sends it Cubex's session cookie, and
// a form or a simple fetch from it could change things in Cubex. Browsers label every request with Sec-Fetch-Site,
// which a page can't set; Cubex's own pages are always 'same-origin' (in dev Vite proxies /api), and 'none' is the
// person typing the address. Anything else ('same-site', 'cross-site') is another site's page. Non-browser
// clients (curl, scripts) send no such header, and reads are left alone: another origin can't read the answer.
import type { Request } from 'express';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CROSS_SITE_REFUSED = 'Cross-site request refused';

export function crossSiteWrite(req: Request): boolean {
  if (READS.has(req.method)) return false;
  const site = req.get('sec-fetch-site');
  return !!site && site !== 'same-origin' && site !== 'none';
}
