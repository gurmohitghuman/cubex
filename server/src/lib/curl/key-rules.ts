// Over 200 lines: the tables that decide what in a pasted cURL command is a key
// (header and field names, key formats, docs placeholders) and the one function
// that reads a key's spot; they belong together and key-detect.ts walks with them.
//
// What counts as a key in a pasted cURL command. Lists follow gitleaks' rules
// and common API docs. Detection is by name and known format: a value that is
// none of these (an opaque token in a URL path, say) can't be told from data.
import { CurlError } from './shared';

export const KEY_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'apikey', 'x-apikey', 'x-auth-token',
  'x-access-token', 'x-api-token', 'token', 'x-token', 'private-token', 'x-goog-api-key', 'ocp-apim-subscription-key',
  'x-rapidapi-key', 'x-shopify-access-token', 'dd-api-key', 'dd-application-key', 'x-amz-security-token',
  'x-treg-token', 'x-csrf-token', 'x-xsrf-token', 'x-csrftoken', 'x-auth-key', 'x-auth', 'x-secret', 'x-api-secret',
  'x-client-secret', 'client-secret', 'x-session-token', 'x-figma-token', 'x-postmark-server-token',
  'cb-access-key', 'cb-access-sign', 'cb-access-passphrase', 'x-honeycomb-team',
]);
// auth(?!or(?!iz)): "authorization" is a key header, "author" and "authority" aren't.
const KEY_HEADER_RE = new RegExp('^(x-([a-z0-9]+[-_])?)?(api[-_]?)?(key|token|secret)$'
  + '|auth(?!or(?!iz))|token|secret|passw|passphrase|api[-_]?key|credential|signature|session', 'i');
export const isKeyHeader = (lower: string) => KEY_HEADERS.has(lower) || KEY_HEADER_RE.test(lower);

// Query and body field names, compared lowercased without - _ . and spaces.
const STRONG_PARAMS = new Set([
  'apikey', 'accesstoken', 'refreshtoken', 'idtoken', 'token', 'authtoken', 'clientsecret', 'secret', 'password',
  'passwd', 'pwd', 'privatetoken', 'apitoken', 'accesskey', 'authkey', 'hapikey', 'licensekey', 'subscriptionkey',
  'signature', 'apisecret', 'sessiontoken', 'xapikey', 'xamzsignature', 'xamzcredential', 'xamzsecuritytoken',
  'xgoogsignature', 'authorization',
]);
const STRONG_PARAM_RE = /token|secret|passw|passphrase|credential|apikey|accesskey|privatekey|signature/;
// Names that are often not keys (?key=status, sort_key=created_at): a value
// counts only when it looks like one (looksLikeKey), or is a placeholder.
const WEAK_PARAMS = new Set(['key', 'sig', 'auth', 'appid']);
// Never keys: ids, page cursors, token counts and types, callback URLs.
const NOT_KEY_NAMES = new Set([
  'idempotencykey', 'sortkey', 'partitionkey', 'cachekey', 'primarykey', 'foreignkey', 'groupkey', 'lookupkey',
  'dedupekey', 'uniquekey', 'objectkey', 'rowkey', 'fieldkey', 'publickey', 'publishablekey',
  'pagetoken', 'nextpagetoken', 'nexttoken', 'prevtoken', 'previoustoken', 'continuationtoken', 'synctoken',
  'resumetoken', 'tokentype', 'tokentypehint', 'oauthcallback',
]);
const paramName = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, '');

export function keyParamStrength(name: string): 'strong' | 'weak' | null {
  const n = paramName(name);
  if (NOT_KEY_NAMES.has(n) || n.endsWith('tokens')) return null; // max_tokens, total_tokens: counts
  if (STRONG_PARAMS.has(n) || (STRONG_PARAM_RE.test(n) && !WEAK_PARAMS.has(n))) return 'strong';
  if (WEAK_PARAMS.has(n) || n.endsWith('key') || /auth(?!or(?!iz))/.test(n)) return 'weak';
  return null;
}

// Key formats worth catching wherever they appear (gitleaks' rules), and
// webhook URLs whose path is the secret (Slack, Discord, a Telegram bot).
export const TOKEN_RE = new RegExp([
  ...[
    'sk-(?:proj-|ant-(?:api\\d{2}-)?|or-v1-)?[A-Za-z0-9_-]{20,}', '(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,}',
    'gh[pousr]_[A-Za-z0-9]{30,}', 'github_pat_[A-Za-z0-9_]{30,}', 'xox[abprs]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}', 'AIza[0-9A-Za-z_-]{35}', 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    'glpat-[A-Za-z0-9_-]{20,}', 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*',
    'cubex_pat_[A-Za-z0-9_-]{16,}', 'treg_[A-Za-z0-9_-]{16,}',
  ].map(p => `(?<![A-Za-z0-9_-])${p}`),
  '(?<=hooks\\.slack\\.com/services/)T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]{20,}',
  '(?<=discord(?:app)?\\.com/api/webhooks/)\\d+/[A-Za-z0-9_-]{30,}',
  '(?<=/bot)\\d{6,}:[A-Za-z0-9_-]{30,}',
].join('|'), 'g');

// What API docs put where a key goes: <YOUR-TOKEN>, [API_KEY], {api_key},
// YOUR_API_KEY, my_secret_key, API_KEY_HERE, xxx, ***.
const PLACEHOLDER_RE = new RegExp('^(?:<[^<>]{1,80}>|\\[[^[\\]]{1,80}\\]|\\{[^{}]{1,80}\\}'
  + '|(?:your|my)[-_ ]?[\\w-]*(?:key|token|secret|password|sid)[\\w-]*|[\\w-]*[-_](?:here|goes[-_]here)'
  + '|x{3,}|\\*{3,}|\\.{3,}|\\u2026|changeme|redacted|placeholder'
  + '|bearer|basic|token|api[-_]?key|secret|password)$', 'i');
// A placeholder is short; testing a long value against the pattern above costs
// more than it can find.
export const isPlaceholder = (t: string) => t.length <= 100 && PLACEHOLDER_RE.test(t);
// An opaque value long enough to be a key: no spaces, letters and digits, not a URL.
export const looksLikeKey = (v: string) => v.length >= 16 && /^[A-Za-z0-9_\-.+/=:~]+$/.test(v)
  && /[A-Za-z]/.test(v) && /\d/.test(v) && !/^https?:/i.test(v);
// Text that could hold a key: a known key format, or a run that looks like one.
const holdsKeyLikeText = (s: string) => s.search(TOKEN_RE) >= 0
  || (s.match(/[A-Za-z0-9_\-.+/=:~]{16,}/g) ?? []).some(looksLikeKey);
const ONE_REF_RE = /^\{\{([^{}]+)\}\}$/;
const REF_RE = /\{\{[^{}]*\}\}/g;

export type Spot = { kind: 'value' } | { kind: 'missing'; placeholder: string; refName?: string };

export interface KeyContext {
  // Whether {{name}} reads a sheet column or a saved key (the template's own rule).
  resolves: (name: string) => boolean;
  variables: string[]; // the command's shell variables, shown as $NAME
}

// What sits in a key's spot: nothing, a reference that resolves (fine as it
// is), a placeholder or unresolved reference (a key is needed), or a literal key.
// References next to literal text that could be part of a key can't be split
// apart safely, so that is refused.
export function classify(text: string, ctx: KeyContext, where: string): Spot | null {
  const t = text.trim();
  if (!t) return null;
  const ref = ONE_REF_RE.exec(t);
  if (ref) {
    const name = ref[1].trim();
    if (ctx.resolves(name)) return null;
    return { kind: 'missing', placeholder: ctx.variables.includes(name) ? `$${name}` : t, refName: name };
  }
  if (t.includes('{{')) {
    if (t.split(REF_RE).some(holdsKeyLikeText)) {
      throw new CurlError(`The ${where} mixes a {{reference}} with text that looks like part of a key. `
        + 'Save the whole key as a saved key, and use {{its_name}} there instead.');
    }
    return null;
  }
  if (isPlaceholder(t)) return { kind: 'missing', placeholder: t };
  return { kind: 'value' };
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'key';

// A hint the person who pasted the key can recognize it by.
export function maskKey(s: string): string {
  if (s.length >= 24) return `${s.slice(0, 4)}…${s.slice(-4)}`;
  if (s.length >= 12) return `${s.slice(0, 3)}…`;
  return '•••';
}
