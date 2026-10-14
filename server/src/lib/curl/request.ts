// Over 200 lines: one cohesive step (curl's rules for what a set of options
// sends: URL, method, the headers it adds or drops, body and sign-in), and each
// rule needs its why.
//
// From the options parse.ts collected to the request an HTTP column sends. It
// follows curl (data means POST, -G moves data to the query, -d joins with &,
// --json joins with nothing, an Authorization header beats -u) with two
// deliberate differences, both reported in `notes`: a JSON body with no
// Content-Type is sent as JSON (curl would send a form, which strict JSON APIs
// refuse), and headers the server can't or shouldn't send are left out.
import { CurlError, VAR_MARKER_RE, VAR_OPEN } from './shared';

export type CurlMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface CurlHeader { name: string; value: string }
export type CurlAuth =
  | { kind: 'basic'; user: string; password: string; from: 'user' | 'url' }
  | { kind: 'bearer'; token: string };

export interface ParsedCurl {
  method: CurlMethod;
  url: string; // with its query string; a shell variable reads {{NAME}}
  headers: CurlHeader[];
  body?: string;
  auth?: CurlAuth; // -u, user:password@ in the URL, or --oauth2-bearer
  variables: string[]; // shell variable names the command used
  notes: string[];
}

export interface CurlState {
  method?: string;
  urls: string[];
  headers: CurlHeader[];
  removed: Set<string>; // "-H 'Name:'" asks curl not to send its own header
  dropped: Set<string>;
  data: Array<{ text: string; json: boolean }>;
  json: boolean;
  get: boolean;
  urlQuery: string[];
  user?: string;
  bearer?: string;
  authScheme?: string;
  userAgent?: string;
  referer?: string;
  cookies: string[];
  notes: Set<string>;
}

const METHODS: CurlMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];
// Connection-level headers undici refuses or computes itself, Accept-Encoding
// (the server doesn't decompress, so a gzip reply would fail to parse as JSON),
// and the ones only a browser sends.
const LEFT_OUT = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer',
  'proxy-connection', 'accept-encoding', 'authority', 'priority', 'upgrade-insecure-requests', 'dnt', 'sec-gpc',
  'x-client-data',
]);
const isLeftOut = (lower: string) =>
  LEFT_OUT.has(lower) || lower.startsWith('sec-ch-') || lower.startsWith('sec-fetch-') || lower.startsWith(':');
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// [^{}], not [^}]: with [^}] a long run of "{" makes every match attempt scan to
// the end (quadratic; 100k characters took seconds).
const REF_RE = /\{\{[^{}]*\}\}/g;
// Headers that hold one value: a repeat replaces the earlier one (joining two
// Content-Types or two Authorizations with ", " would send a value nobody meant).
const SINGLE_VALUE = new Set([
  'content-type', 'authorization', 'proxy-authorization', 'user-agent', 'referer', 'origin',
]);

export function buildRequest(st: CurlState): ParsedCurl {
  if (st.urls.length === 0) throw new CurlError('This command has no URL.');
  if (st.urls.length > 1) {
    throw new CurlError(`This command calls ${st.urls.length} URLs. Paste one request at a time.`);
  }
  const target = splitUrl(st.urls[0], st);
  let url = target.url;
  const data = st.data.length === 0 ? undefined
    : st.data.reduce((acc, p, i) => (i === 0 ? p.text : acc + (p.json ? '' : '&') + p.text), '');
  const explicit = st.method?.trim().toUpperCase();
  let method: string;
  let body: string | undefined;
  if (st.get) {
    method = explicit || 'GET';
    if (data !== undefined) url = appendQuery(url, data);
  } else {
    method = explicit || (data !== undefined ? 'POST' : 'GET');
    body = data;
  }
  if (st.urlQuery.length) url = appendQuery(url, st.urlQuery.join('&'));
  if (method === 'HEAD') throw new CurlError("HEAD requests (-I) don't return JSON, so an HTTP column can't use them.");
  if (!METHODS.includes(method as CurlMethod)) {
    const shown = /^[A-Z]{1,16}$/.test(method) ? `${method} requests aren't` : "That method isn't";
    throw new CurlError(`${shown} supported. An HTTP column sends GET, POST, PUT or DELETE.`);
  }
  if (method === 'GET' && body !== undefined) {
    throw new CurlError(
      "This command sends a body with GET, which an HTTP column can't do. "
      + 'Use POST, or add -G to send the data in the URL.',
    );
  }
  const headers = finalHeaders(st, body);
  const auth = finalAuth(st, target.creds, headers);

  const variables = new Set<string>();
  const ref = (s: string) => s.replace(VAR_MARKER_RE, (_m, name: string) => {
    variables.add(name);
    return `{{${name}}}`;
  });
  const out: ParsedCurl = {
    method: method as CurlMethod,
    url: ref(url),
    headers: headers.map(h => ({ name: ref(h.name), value: ref(h.value) })),
    ...(body !== undefined ? { body: ref(body) } : {}),
    ...(auth?.kind === 'basic' ? { auth: { ...auth, user: ref(auth.user), password: ref(auth.password) } } : {}),
    ...(auth?.kind === 'bearer' ? { auth: { kind: 'bearer' as const, token: ref(auth.token) } } : {}),
    variables: [...variables],
    notes: [...st.notes],
  };
  validate(out);
  return out;
}

function splitUrl(raw: string, st: CurlState): { url: string; creds?: { user: string; password: string } } {
  // Chrome escapes [ ] { } in URLs for curl's globbing; the backslash isn't part of the URL.
  let url = raw.trim().replace(/\\([[\]{}])/g, '$1');
  const hash = url.replace(REF_RE, m => '_'.repeat(m.length)).indexOf('#'); // a {{# Revenue}} ref isn't a fragment
  if (hash >= 0) url = url.slice(0, hash);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (!scheme) {
    if (!url.startsWith(VAR_OPEN) && !url.startsWith('{{')) {
      url = `https://${url}`;
      st.notes.add('The URL had no http:// or https://, so https:// was added.');
    }
  } else if (!/^https?$/i.test(scheme[1])) {
    throw new CurlError('Only http:// and https:// URLs work here.');
  }
  // user:password@ ends at the LAST @ before the path (a password can hold an @),
  // as browsers read it; validate() refuses a URL that still carries one.
  const scheme2 = /^https?:\/\//i.exec(url);
  if (!scheme2) return { url };
  const authorityEnd = url.slice(scheme2[0].length).search(/[/?#]/);
  const authority = url.slice(scheme2[0].length, authorityEnd < 0 ? undefined : scheme2[0].length + authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at < 0) return { url };
  const info = authority.slice(0, at);
  const colon = info.indexOf(':');
  const part = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  return {
    url: scheme2[0] + url.slice(scheme2[0].length + at + 1),
    creds: colon < 0 ? { user: part(info), password: '' }
      : { user: part(info.slice(0, colon)), password: part(info.slice(colon + 1)) },
  };
}

function appendQuery(url: string, qs: string): string {
  if (!qs) return url;
  return url + (!url.includes('?') ? '?' : /[?&]$/.test(url) ? '' : '&') + qs;
}

function finalHeaders(st: CurlState, body: string | undefined): CurlHeader[] {
  const merged = new Map<string, CurlHeader>();
  for (const h of st.headers) {
    const lower = h.name.toLowerCase();
    if (isLeftOut(lower)) { st.dropped.add(lower); continue; }
    const prev = merged.get(lower);
    if (!prev) { merged.set(lower, { ...h }); continue; }
    if (SINGLE_VALUE.has(lower)) {
      prev.value = h.value;
      st.notes.add(`Only the last ${h.name} header was kept.`);
    } else {
      prev.value += (lower === 'cookie' ? '; ' : ', ') + h.value;
      st.notes.add(`The repeated ${h.name} headers were joined into one.`);
    }
  }
  const imply = (name: string, value: string) => {
    const lower = name.toLowerCase();
    if (!merged.has(lower) && !st.removed.has(lower)) merged.set(lower, { name, value });
  };
  if (st.userAgent) imply('User-Agent', st.userAgent);
  if (st.referer) imply('Referer', st.referer);
  if (st.cookies.length > 0) {
    if (!merged.has('cookie')) imply('Cookie', st.cookies.join('; '));
    else st.notes.add('-b was ignored: the command also sets a Cookie header, which curl sends instead.');
  }
  if (body !== undefined) {
    if (st.json) {
      imply('Content-Type', 'application/json');
      imply('Accept', 'application/json');
    } else if (!merged.has('content-type') && !st.removed.has('content-type')) {
      // The server never adds a Content-Type, so the one curl implies is written out.
      if (looksLikeJson(body)) {
        imply('Content-Type', 'application/json');
        st.notes.add("The body is JSON but the command didn't say so, so Content-Type: application/json was added.");
      } else {
        imply('Content-Type', 'application/x-www-form-urlencoded');
      }
    }
  }
  if (st.dropped.size > 0) {
    st.notes.add(`Left out headers that browsers and curl add on their own: ${[...st.dropped].join(', ')}.`);
  }
  return [...merged.values()];
}

function finalAuth(
  st: CurlState, creds: { user: string; password: string } | undefined, headers: CurlHeader[],
): CurlAuth | undefined {
  let auth: CurlAuth | undefined;
  if (st.user !== undefined) {
    const colon = st.user.indexOf(':');
    if (colon < 0) st.notes.add('-u had no password, so it is sent empty (curl would have asked for one).');
    auth = colon < 0 ? { kind: 'basic', user: st.user, password: '', from: 'user' }
      : { kind: 'basic', user: st.user.slice(0, colon), password: st.user.slice(colon + 1), from: 'user' };
  } else if (creds) {
    auth = { kind: 'basic', ...creds, from: 'url' };
  } else if (st.bearer !== undefined) {
    auth = { kind: 'bearer', token: st.bearer };
  }
  if (auth && st.authScheme) {
    throw new CurlError("Digest, NTLM and Negotiate sign-in aren't supported. Basic sign-in (-u) and headers are.");
  }
  if (auth && headers.some(h => h.name.toLowerCase() === 'authorization')) {
    const option = auth.kind === 'bearer' ? '--oauth2-bearer'
      : auth.from === 'url' ? 'The URL\'s user and password' : '-u';
    st.notes.add(`${option} was ignored: the command also sets an Authorization header, which curl sends instead.`);
    return undefined;
  }
  return auth;
}

function looksLikeJson(body: string): boolean {
  const t = body.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t.replace(VAR_MARKER_RE, '0').replace(REF_RE, '0'));
    return true;
  } catch {
    return false;
  }
}

// What the server would refuse per row is refused now. Messages never quote a
// header value or the URL: either can hold a key.
function validate(p: ParsedCurl): void {
  for (const h of p.headers) {
    if (!HEADER_NAME_RE.test(h.name) && !h.name.includes('{{')) {
      throw new CurlError("A header name isn't valid: header names can't have spaces or quotes.");
    }
    if (/[\r\n\0]/.test(h.value)) {
      throw new CurlError(`The ${h.name} header has a line break in it, which HTTP doesn't allow.`);
    }
  }
  if (p.url.startsWith('{{')) return;
  let u: URL;
  try {
    u = new URL(p.url.replace(REF_RE, 'x'));
  } catch {
    throw new CurlError("The URL isn't valid.");
  }
  if (!u.hostname) throw new CurlError("The URL isn't valid.");
  if (u.username || u.password) throw new CurlError("The URL's user and password couldn't be read. Use -u instead.");
}
