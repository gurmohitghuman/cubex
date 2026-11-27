// An HTTP API row's redirects (pure): which answer is one to follow and what the next request is. The request path
// (lib/http-request.ts) runs the full outbound guard (lib/outbound-guard.ts: address check and DNS pin) on every hop,
// so a redirect can't reach an address a first request couldn't; this module only says where it goes and with what.
//
// - Followed: 301, 302, 303, 307 and 308 with a Location, at most HTTP_MAX_REDIRECTS times.
// - Never from https to http: what the template sent over TLS isn't sent in clear.
// - 303, and 301 or 302 after a POST, go on as GET with no body (as browsers do); 307 and 308 keep method and body.
// - To another origin (scheme, host or port), only HTTP_REDIRECT_KEPT_HEADERS go along: a key, a token or a cookie
//   in the template's headers is never sent to a host it wasn't written for. A body (307 or 308 keep it) never goes
//   to another origin either: such a redirect is refused.

export const HTTP_MAX_REDIRECTS = 5;
export const HTTP_REDIRECT_KEPT_HEADERS: ReadonlySet<string> = new Set(['accept', 'accept-language', 'user-agent']);

export interface Hop { url: string; method: string; headers: Record<string, string>; body: string | undefined }

const FOLLOWED = new Set([301, 302, 303, 307, 308]);

// The next request a redirect answer asks for; { error } when it asks for one that must not be sent; null when the
// answer isn't a redirect to follow (it is then the answer, as any other status).
export function nextHop(current: Hop, status: number, location: string | string[] | undefined):
  { ok: Hop } | { error: string } | null {
  if (!FOLLOWED.has(status)) return null;
  const where = Array.isArray(location) ? location[0] : location;
  if (!where || !where.trim()) return null;
  let next: URL;
  let from: URL;
  try {
    from = new URL(current.url);
    next = new URL(where.trim(), from);
  } catch {
    return { error: `HTTP ${status} redirected to an address that isn't a URL.` };
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    return { error: `HTTP ${status} redirected to a ${next.protocol.replace(':', '')} address: only http and https.` };
  }
  if (from.protocol === 'https:' && next.protocol === 'http:') {
    return { error: `HTTP ${status} redirected from https to http (${next.host}); Cubex doesn't follow that.` };
  }
  const asGet = status === 303 || ((status === 301 || status === 302) && current.method === 'POST');
  const method = asGet && current.method !== 'HEAD' ? 'GET' : current.method;
  const body = asGet ? undefined : current.body;
  const sameOrigin = next.origin === from.origin;
  if (!sameOrigin && body) {
    return { error: `HTTP ${status} redirected a request with a body to another host (${next.host}); Cubex doesn't `
      + 'send it there.' };
  }
  const headers = Object.fromEntries(Object.entries(current.headers).filter(([name]) => {
    const n = name.toLowerCase();
    if (!body && (n === 'content-type' || n === 'content-length')) return false;
    return sameOrigin || HTTP_REDIRECT_KEPT_HEADERS.has(n);
  }));
  return { ok: { url: next.toString(), method, headers, body } };
}
