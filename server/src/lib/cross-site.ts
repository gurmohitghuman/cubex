// Cookie-session writes from another site are refused. SameSite=Strict (lib/cookie.ts) ignores ports, so a page of
// another app on the same host (another port) counts as same-site: the browser sends it Cubex's session cookie, and
// a form or a simple fetch from it could change things in Cubex. Browsers label requests to HTTPS and localhost
// addresses with Sec-Fetch-Site, which a page can't set; Cubex's own pages are always 'same-origin' (in dev Vite
// proxies /api), and 'none' is the person typing the address. Anything else ('same-site', 'cross-site') is another
// site's page. Over plain HTTP to any other address (a LAN install, http://myhost:3002) browsers send no
// Sec-Fetch-Site, so there the write's Origin must be the address it was sent to (its Host) or PUBLIC_URL's;
// 'null' (a sandboxed frame) is another site's. Non-browser clients (curl, scripts) send neither header, and reads
// are left alone: another origin can't read the answer.
import type { Request } from 'express';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CROSS_SITE_REFUSED = 'Cross-site request refused';

// Behind a proxy over plain HTTP that changes the Host header, Cubex's own pages fail this check too: say once in
// the server log what fixes it.
let warned = false;

function ownOrigin(origin: string, host: string | undefined): boolean {
  let page: URL;
  try { page = new URL(origin); } catch { return false; }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
  try {
    if (host && new URL(`${page.protocol}//${host}`).host === page.host) return true;
  } catch { /* a Host that isn't an address: only PUBLIC_URL can match */ }
  try {
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl && new URL(publicUrl).origin === page.origin) return true;
  } catch { /* an unreadable PUBLIC_URL matches nothing */ }
  if (!warned) {
    warned = true;
    const from = JSON.stringify(origin.slice(0, 200));
    console.warn(`Refused a change sent from ${from} to ${JSON.stringify(host ?? '')}: not this server's address.`
      + ' If that is where Cubex is opened (a proxy that changes the Host header), set PUBLIC_URL to it or have the'
      + ' proxy pass the Host header.');
  }
  return false;
}

export function crossSiteWrite(req: Request): boolean {
  if (READS.has(req.method)) return false;
  const site = req.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.get('origin');
  return origin !== undefined && !ownOrigin(origin, req.get('host'));
}
