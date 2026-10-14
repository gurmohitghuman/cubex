// Finds the API keys and tokens in a parsed cURL command, so none it finds is
// ever stored in a column's setup: key-apply.ts refuses to build a request
// until each one is saved as a saved key, swapped for one, or left out.
// A finding is either a literal key ('value') or a spot that needs one
// ('missing': $OPENAI_API_KEY, <YOUR-TOKEN>, a {{name}} that resolves to
// nothing). What counts as a key: key-rules.ts.
import { CURL_MAX_KEYS } from '../constants-curl';
import { CurlError } from './shared';
import type { CurlAuth, CurlHeader, CurlMethod, ParsedCurl } from './request';
import {
  TOKEN_RE, classify, isKeyHeader, isPlaceholder, keyParamStrength, looksLikeKey, slug, type KeyContext, type Spot,
} from './key-rules';

export interface Draft {
  method: CurlMethod;
  base: string; // the URL up to its query string
  query: Array<{ key: string; value: string; bare: boolean }>; // raw, never decoded
  headers: CurlHeader[];
  body?: string;
  auth?: CurlAuth;
}

export type KeyField = { at: 'header' | 'query'; index: number } | { at: 'auth' | 'body' | 'url' };

export interface KeyFinding {
  id: string; // where it sits, so the same command gives the same ids
  where: string; // "Authorization header", "api_key in the URL", "-u user and password"
  field: KeyField;
  inKey?: boolean; // the span is in a query parameter's name (?sk-...): a bare parameter
  start: number; // the key's span inside the field's text
  end: number;
  kind: 'value' | 'missing';
  secret?: string; // a literal key; for -u, base64(user:password). Never leaves the server.
  placeholder?: string; // what stands in for a missing key
  refName?: string; // a missing {{name}} or $NAME: suggested as the saved key's name
  insert?: string; // text written before {{name}} (an Authorization scheme)
  basic: boolean; // Basic sign-in: the saved key holds base64(user:password)
  cookie: boolean;
  canDrop: boolean;
  role: string; // a short slug for naming the key
}

export function toDraft(p: ParsedCurl): Draft {
  const q = p.url.indexOf('?');
  const query = q < 0 ? [] : p.url.slice(q + 1).split('&').filter(Boolean).map(part => {
    const eq = part.indexOf('=');
    return eq < 0 ? { key: part, value: '', bare: true }
      : { key: part.slice(0, eq), value: part.slice(eq + 1), bare: false };
  });
  return {
    method: p.method, base: q < 0 ? p.url : p.url.slice(0, q), query,
    headers: p.headers.map(h => ({ ...h })), body: p.body, auth: p.auth,
  };
}

type NewFinding = Omit<KeyFinding, 'basic' | 'cookie' | 'canDrop' | 'kind'>
  & Partial<Pick<KeyFinding, 'basic' | 'cookie' | 'canDrop'>>;
type Add = (f: NewFinding, spot: Spot) => void;

export function findKeys(d: Draft, ctx: KeyContext): KeyFinding[] {
  const found: KeyFinding[] = [];
  const add: Add = (f, spot) => {
    if (found.length >= CURL_MAX_KEYS) {
      throw new CurlError(`This command has more than ${CURL_MAX_KEYS} keys in it. Paste one with fewer.`);
    }
    found.push({
      basic: false, cookie: false, canDrop: true, ...f, kind: spot.kind,
      ...(spot.kind === 'missing' ? { placeholder: spot.placeholder, refName: spot.refName } : {}),
    });
  };
  // A key header or parameter is handled once a finding covers it; one that
  // holds only references still gets the key-format scan below.
  const handledHeaders = new Set<number>();
  d.headers.forEach((h, index) => {
    const lower = h.name.toLowerCase();
    if (!isKeyHeader(lower)) return;
    const isAuth = lower === 'authorization' || lower === 'proxy-authorization';
    const scheme = isAuth ? /^([A-Za-z][A-Za-z0-9_-]*)\s+(?=\S)/.exec(h.value) : null;
    const bareScheme = isAuth && /^(bearer|basic|token)\s*$/i.test(h.value);
    const start = scheme ? scheme[0].length : 0;
    const where = `${h.name} header`;
    const spot = classify(h.value.slice(start), ctx, where);
    if (!spot) return;
    handledHeaders.add(index);
    add({
      id: `header:${index}`, where, field: { at: 'header', index }, start, end: h.value.length,
      secret: spot.kind === 'value' ? h.value.slice(start).trim() : undefined,
      insert: bareScheme ? `${h.value.trim()} ` : undefined, cookie: lower === 'cookie',
      role: isAuth ? 'auth' : lower === 'cookie' ? 'cookie' : slug(lower),
    }, spot);
  });
  if (d.auth) addAuth(d.auth, ctx, add);
  const handledParams = new Set<number>();
  d.query.forEach((p, index) => {
    if (p.bare || !keyField(p.key, p.value)) return;
    const where = `${p.key} in the URL`;
    const spot = classify(p.value, ctx, where);
    if (!spot) return;
    handledParams.add(index);
    add({
      id: `query:${index}`, where, field: { at: 'query', index }, start: 0, end: p.value.length,
      secret: spot.kind === 'value' ? p.value : undefined, role: slug(p.key),
    }, spot);
  });
  const bodySpans = d.body ? bodyKeys(d.body, ctx, add) : [];
  // Known key formats anywhere else, each match its own finding.
  const scan = (
    text: string, field: KeyField, id: string, where: string, skip: Array<[number, number]>, inKey = false,
  ) => {
    for (const m of text.matchAll(TOKEN_RE)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (skip.some(([a, b]) => start < b && end > a)) continue;
      add({
        id: `${id}@${start}`, where, field, start, end, secret: m[0], role: 'key', inKey,
        canDrop: field.at === 'header' || field.at === 'query',
      }, { kind: 'value' });
    }
  };
  scan(d.base, { at: 'url' }, 'url', 'the URL', []);
  d.headers.forEach((h, index) => {
    if (!handledHeaders.has(index)) scan(h.value, { at: 'header', index }, `header:${index}`, `${h.name} header`, []);
  });
  d.query.forEach((p, index) => {
    if (handledParams.has(index)) return;
    if (p.bare) scan(p.key, { at: 'query', index }, `query:${index}`, 'the URL', [], true);
    else scan(p.value, { at: 'query', index }, `query:${index}`, `${p.key} in the URL`, []);
  });
  if (d.body) scan(d.body, { at: 'body' }, 'body', 'the body', bodySpans);
  // Two findings can't share a label (agents name keys by it).
  const seen = new Map<string, number>();
  for (const f of found) {
    const n = (seen.get(f.where) ?? 0) + 1;
    seen.set(f.where, n);
    if (n > 1) f.where = `${f.where} (${n})`;
  }
  return found;
}

// A field named like a key: always for strong names (api_key, client_secret),
// for weak ones only with a key-like value or a placeholder (?key=status isn't one).
function keyField(name: string, value: string): boolean {
  const strength = keyParamStrength(name);
  return strength === 'strong'
    || (strength === 'weak' && (looksLikeKey(value) || value.includes('{{') || isPlaceholder(value.trim())));
}

function addAuth(auth: CurlAuth, ctx: KeyContext, add: Add): void {
  if (auth.kind === 'bearer') {
    const spot = classify(auth.token, ctx, '--oauth2-bearer token');
    if (spot) {
      add({
        id: 'auth', where: '--oauth2-bearer token', field: { at: 'auth' }, start: 0, end: 0,
        secret: spot.kind === 'value' ? auth.token : undefined, insert: 'Bearer ', role: 'auth',
      }, spot);
    }
    return;
  }
  const where = auth.from === 'url' ? 'user and password in the URL' : '-u user and password';
  const pair = `${auth.user}:${auth.password}`;
  if (!auth.user && !auth.password) return;
  // Basic sign-in is base64(user:password), which a {{reference}} can't be
  // filled into, so any reference or placeholder here needs a saved key.
  const literal = [auth.user, auth.password].every(p => !p.includes('{{') && !isPlaceholder(p.trim()));
  add({
    id: 'auth', where, field: { at: 'auth' }, start: 0, end: 0, insert: 'Basic ', basic: true, role: 'auth',
    secret: literal ? Buffer.from(pair, 'utf8').toString('base64') : undefined,
  }, literal ? { kind: 'value' } : { kind: 'missing', placeholder: pair });
}

// "api_key": "..." in a JSON body, api_key=... in a form body. Spans are the value
// as written (JSON escapes included), which is what gets swapped for {{name}}.
function bodyKeys(body: string, ctx: KeyContext, add: Add): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const hit = (name: string, value: string, start: number) => {
    if (!keyField(name, value)) return;
    const where = `${name} in the body`;
    const spot = classify(value, ctx, where);
    if (!spot) return;
    const end = start + value.length;
    spans.push([start, end]);
    add({
      id: `body:${start}`, where, field: { at: 'body' }, start, end,
      secret: spot.kind === 'value' ? value : undefined, canDrop: false, role: slug(name),
    }, spot);
  };
  if (/^\s*[[{]/.test(body)) {
    for (const m of body.matchAll(/"([^"\\]{1,128})"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      hit(m[1], m[2], (m.index ?? 0) + m[0].length - 1 - m[2].length);
    }
    return spans;
  }
  let offset = 0;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) hit(part.slice(0, eq), part.slice(eq + 1), offset + eq + 1);
    offset += part.length + 1;
  }
  return spans;
}
