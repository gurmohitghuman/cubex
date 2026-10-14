// Bash's quoted strings and $variables, for tokenize.ts. Each reader starts just
// inside its opening quote and returns the text plus the index after the closing one.
import { COMMAND_SUBSTITUTION, CurlError, SHELL_NAME_RE, UNCLOSED_QUOTE, varMarker } from './shared';

export interface Read { text: string; end: number }

// $NAME and ${NAME} become variable markers (${NAME:-default} keeps NAME; the
// default is a shell feature). $(...) runs a command, which a paste can't do. A $
// before anything else is just a dollar sign.
export function readDollar(s: string, i: number): Read {
  const next = s[i + 1];
  if (next === '(') throw new CurlError(COMMAND_SUBSTITUTION);
  if (next === '{') {
    const close = s.indexOf('}', i + 2);
    if (close < 0) throw new CurlError(UNCLOSED_QUOTE);
    const name = SHELL_NAME_RE.exec(s.slice(i + 2, close));
    return { text: name ? varMarker(name[0]) : s.slice(i, close + 1), end: close + 1 };
  }
  const name = SHELL_NAME_RE.exec(s.slice(i + 1, i + 256));
  return name ? { text: varMarker(name[0]), end: i + 1 + name[0].length } : { text: '$', end: i + 1 };
}

// "...": only \\ \$ \` \" and backslash-newline are escapes; any other backslash
// stays (so "a\nb" is a, backslash, n, b). $variables expand, backticks run a command.
export function readDoubleQuoted(s: string, start: number): Read {
  let out = '';
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { text: out, end: i + 1 };
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '\n') { i += 2; continue; }
      if (n === '\\' || n === '$' || n === '`' || n === '"') { out += n; i += 2; continue; }
      out += c; i++; continue;
    }
    if (c === '$') { const r = readDollar(s, i); out += r.text; i = r.end; continue; }
    if (c === '`') throw new CurlError(COMMAND_SUBSTITUTION);
    out += c; i++;
  }
  throw new CurlError(UNCLOSED_QUOTE);
}

const ANSI_SIMPLE = new Map<string, string>([
  ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?'], ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['E', '\x1b'],
  ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'],
]);
const utf8 = new TextDecoder('utf-8', { fatal: true });

// $'...' (Chrome and Firefox "Copy as cURL (bash)" use it for bodies with line
// breaks, quotes or non-ASCII). Escapes per the bash manual: the simple ones
// above, octal \NNN, \xHH, \uHHHH, \UHHHHHHHH and \cX. \x and octal give BYTES:
// a run of them reads as UTF-8 when it is valid UTF-8 (a bash user's \xc3\xa9)
// and as one character per byte otherwise (Firefox and Safari write \xe9 for é).
export function readAnsiC(s: string, start: number): Read {
  let out = '';
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length === 0) return;
    try {
      out += utf8.decode(Uint8Array.from(bytes));
    } catch {
      for (const b of bytes) out += String.fromCharCode(b);
    }
    bytes = [];
  };
  let i = start;
  while (i < s.length) {
    const c = s[i];
    // An escape can't make a variable marker (shared.ts): they're dropped here too.
    if (c === "'") { flush(); return { text: out.replace(/[\uE000\uE001]/g, ''), end: i + 1 }; }
    if (c !== '\\' || i + 1 >= s.length) { flush(); out += c; i++; continue; }
    const n = s[i + 1];
    const simple = ANSI_SIMPLE.get(n);
    if (simple !== undefined) { flush(); out += simple; i += 2; continue; }
    let m: RegExpExecArray | null;
    if (n === 'x' && (m = /^[0-9A-Fa-f]{1,2}/.exec(s.slice(i + 2, i + 4)))) {
      bytes.push(parseInt(m[0], 16)); i += 2 + m[0].length; continue;
    }
    if (n >= '0' && n <= '7') {
      m = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))!;
      bytes.push(parseInt(m[0], 8) & 0xff); i += 1 + m[0].length; continue;
    }
    const hexRun = n === 'u' ? /^[0-9A-Fa-f]{1,4}/ : /^[0-9A-Fa-f]{1,8}/;
    if ((n === 'u' || n === 'U') && (m = hexRun.exec(s.slice(i + 2, i + 10)))) {
      flush();
      const cp = parseInt(m[0], 16);
      // Surrogate halves (\ud83d\ude00) are kept as code units, so a pair joins up.
      out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD';
      i += 2 + m[0].length; continue;
    }
    if (n === 'c' && i + 2 < s.length) {
      flush(); out += String.fromCharCode(s.charCodeAt(i + 2) & 0x1f); i += 3; continue;
    }
    flush(); out += c + n; i += 2; // unknown escape: bash keeps the backslash
  }
  throw new CurlError(UNCLOSED_QUOTE);
}
