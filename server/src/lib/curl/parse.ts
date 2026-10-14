// Turns a pasted cURL command into the request it sends: walks curl's
// arguments with curl's own rules (options.ts for arity; combined short flags
// like -sSL, attached values like -XPOST or -H'X: y', --opt=value from curl
// 8.16, -- ends options) and collects them in a CurlState that request.ts turns
// into method, URL, headers and body. Anything an HTTP column can't send is
// refused with a plain reason rather than silently dropped.
import { splitCurlCommand } from './tokenize';
import { SHORT_OPTIONS, optionArity } from './options';
import { CurlError } from './shared';
import { buildRequest, type CurlState, type ParsedCurl } from './request';
import { formEncode } from './url-encode';

export type { ParsedCurl, CurlAuth, CurlHeader, CurlMethod } from './request';

const FORMS = "Forms and file uploads (-F) aren't supported. An HTTP column sends a JSON or form body.";
const FILE_DATA = "-d @file reads a file from your computer. Paste the file's contents into the command instead.";
const CERTS = "Client certificates aren't supported.";
const SOCKETS = "Unix sockets aren't supported.";
const VARIABLES = "curl variables (--variable, --expand-...) aren't supported. Put the values in the command.";
const REFUSED: Record<string, string> = {
  form: FORMS, 'form-string': FORMS, cert: CERTS, key: CERTS, pass: CERTS, 'cert-type': CERTS, 'key-type': CERTS,
  'upload-file': "Uploading a file (-T) isn't supported.",
  config: "-K reads options from a file, which isn't supported. Paste the whole command instead.",
  'aws-sigv4': "AWS request signing isn't supported: it needs a fresh signature for every request.",
  'unix-socket': SOCKETS, 'abstract-unix-socket': SOCKETS, variable: VARIABLES,
  next: 'This command sends more than one request. Paste one request at a time.',
  head: "HEAD requests (-I) don't return JSON, so an HTTP column can't use them.",
  'request-target': "--request-target isn't supported.",
};
const NOTES: Record<string, string> = {
  insecure: '-k was ignored: Cubex always checks HTTPS certificates.',
  location: "-L was ignored: Cubex doesn't follow redirects, so use the final URL.",
  proxy: 'The proxy setting was ignored. Requests go out directly.',
  resolve: '--resolve and --connect-to were ignored.',
};
const NOTE_FOR: Record<string, string> = {
  insecure: 'insecure', 'proxy-insecure': 'insecure', location: 'location', 'location-trusted': 'location',
  proxy: 'proxy', preproxy: 'proxy', socks4: 'proxy', socks4a: 'proxy', socks5: 'proxy', 'socks5-hostname': 'proxy',
  resolve: 'resolve', 'connect-to': 'resolve',
};
// PowerShell's Invoke-WebRequest answers to "curl" in Windows PowerShell 5.1.
const INVOKE_WEB_REQUEST_RE = /^-(uri|method|headers|body|contenttype|usebasicparsing)$/i;

export function parseCurl(input: string): ParsedCurl {
  const cmd = splitCurlCommand(input);
  const st: CurlState = {
    urls: [], headers: [], removed: new Set(), dropped: new Set(), data: [], json: false, get: false,
    urlQuery: [], cookies: [], notes: new Set(cmd.notes),
  };
  const a = cmd.args;
  let optionsDone = false;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (!optionsDone && w === '--') { optionsDone = true; continue; }
    if (optionsDone || !w.startsWith('-') || w === '-') { st.urls.push(w); continue; }
    if (INVOKE_WEB_REQUEST_RE.test(w)) {
      throw new CurlError("This is PowerShell's Invoke-WebRequest, not cURL. Copy the cURL version instead.");
    }
    const takeValue = (label: string): string => {
      if (i + 1 >= a.length) throw new CurlError(`${label} needs a value.`);
      return a[++i];
    };
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const label = eq > 0 ? w.slice(0, eq) : w;
      const name = label.slice(2);
      if (name.startsWith('expand-')) throw new CurlError(VARIABLES);
      const arity = optionArity(name);
      if (!arity) throw new CurlError(`${label} isn't a curl option this can read. Remove it and paste again.`);
      if (arity === 'flag') {
        if (eq > 0) throw new CurlError(`${label} doesn't take a value.`);
        apply(st, name, '');
      } else {
        apply(st, name, eq > 0 ? w.slice(eq + 1) : takeValue(label));
      }
      continue;
    }
    for (let j = 1; j < w.length; j++) {
      const name = SHORT_OPTIONS[w[j]];
      if (!name) throw new CurlError(`-${w[j]} isn't a curl option this can read. Remove it and paste again.`);
      if (optionArity(name) === 'flag') { apply(st, name, ''); continue; }
      const rest = w.slice(j + 1);
      apply(st, name, rest || takeValue(`-${w[j]}`));
      break;
    }
  }
  return buildRequest(st);
}

function apply(st: CurlState, name: string, value: string): void {
  if (REFUSED[name]) throw new CurlError(REFUSED[name]);
  if (NOTE_FOR[name]) { st.notes.add(NOTES[NOTE_FOR[name]]); return; }
  switch (name) {
    case 'request': st.method = value; return;
    case 'header': addHeader(st, value); return;
    case 'data': case 'data-ascii': case 'data-binary': st.data.push({ text: noFile(value), json: false }); return;
    case 'data-raw': st.data.push({ text: value, json: false }); return;
    case 'data-urlencode': st.data.push({ text: urlencodeArg(value), json: false }); return;
    case 'json': st.data.push({ text: noFile(value), json: true }); st.json = true; return;
    case 'url-query': st.urlQuery.push(value.startsWith('+') ? value.slice(1) : urlencodeArg(value)); return;
    case 'url': st.urls.push(value); return;
    case 'get': st.get = true; return;
    case 'user': st.user = value; return;
    case 'oauth2-bearer': st.bearer = value; return;
    case 'user-agent': st.userAgent = value; return;
    case 'referer': st.referer = value.replace(/;auto$/, ''); return;
    case 'cookie':
      if (value.includes('=')) st.cookies.push(value);
      else st.notes.add('-b names a cookie file, which was ignored.');
      return;
    case 'digest': case 'ntlm': case 'ntlm-wb': case 'negotiate': st.authScheme = name; return;
    default: // every other option changes nothing about the request itself
  }
}

// -H: the name is everything before the first colon. "Name;" sends an empty
// header, "Name:" removes one curl adds itself, and curl doesn't send a header
// with no colon at all (its text is never echoed: it could be a pasted key).
function addHeader(st: CurlState, raw: string): void {
  if (raw.startsWith('@')) {
    throw new CurlError('-H @file reads headers from a file. Paste them as -H options instead.');
  }
  const colon = raw.indexOf(':');
  const semi = raw.indexOf(';');
  if (colon < 0 || (semi >= 0 && semi < colon)) {
    if (/^[^;]+;\s*$/.test(raw)) st.headers.push({ name: raw.slice(0, semi).trim(), value: '' });
    else st.notes.add("A -H value without a colon isn't sent by curl, so it was left out.");
    return;
  }
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!name) { // ":authority: \u2026" from HTTP/2 copies
    const pseudo = /^:[a-z-]+(?=:)/i.exec(raw);
    if (pseudo) st.dropped.add(pseudo[0].toLowerCase());
    return;
  }
  if (!value) { st.removed.add(name.toLowerCase()); return; }
  st.headers.push({ name, value });
}

function noFile(value: string): string {
  if (value.startsWith('@')) throw new CurlError(FILE_DATA);
  return value;
}

// --data-urlencode and --url-query take "content", "=content", "name=content",
// "@file" or "name@file": whichever of = and @ comes first decides. Only the
// content is encoded, the name is sent as written.
function urlencodeArg(v: string): string {
  const m = /[=@]/.exec(v);
  if (!m) return formEncode(v);
  if (m[0] === '@') throw new CurlError(FILE_DATA);
  const name = v.slice(0, m.index);
  const content = formEncode(v.slice(m.index + 1));
  return name ? `${name}=${content}` : content;
}
