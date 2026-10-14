// Windows dialects for tokenize.ts. A cmd command line passes through two
// parsers: cmd.exe (^ escapes, "..." turns them off, %VAR%) and then curl.exe's C
// runtime, which splits arguments ("..." groups, \" is a quote, "" inside quotes is
// a quote). PowerShell has its own quoting (` escapes, '...' with '', "..." with $vars).
import {
  BLANKS, COMMAND_SUBSTITUTION, CurlError, SHELL_NAME_RE, UNCLOSED_QUOTE, continuationEnd, nextLineIsOption, varMarker,
} from './shared';

export function cmdCommands(s: string): string[][] {
  // Chrome's "Copy as cURL (cmd)" wraps every value in ^"...^" and doubles every
  // backslash, so a doubled backslash there stands for one.
  const chrome = /(^|\s)\^"/.test(s);
  return cmdLines(s).map(line => crtSplit(line, chrome)).filter(w => w.length > 0);
}

// cmd.exe's pass. ^ outside quotes escapes the next character; ^ + line break
// continues the line and keeps the character after the break as typed (Chrome
// writes a line break inside a value as ^, break, break). %NAME% is a variable
// (not %E2%, which is percent-encoding). A bare line break, |, &&, || or > ends
// the command; a & inside a word is kept, as in bash.
function cmdLines(s: string): string[] {
  const lines: string[] = [];
  let out = '';
  let inQuotes = false;
  const end = () => { if (out.trim()) lines.push(out); out = ''; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '^' && !inQuotes) {
      if (s[i + 1] === '\n') { if (i + 2 < s.length) out += s[i + 2]; i += 3; continue; }
      if (i + 1 < s.length) out += s[i + 1];
      i += 2; continue;
    }
    if (c === '"') { inQuotes = !inQuotes; out += c; i++; continue; }
    if (c === '%') {
      const m = /^%([A-Za-z_][A-Za-z0-9_]*)%/.exec(s.slice(i, i + 256));
      if (m && !/^[0-9A-Fa-f]{2}$/.test(m[1])) { out += varMarker(m[1]); i += m[0].length; continue; }
    }
    if (!inQuotes && c === '\n') { if (!nextLineIsOption(s, i + 1)) end(); else out += ' '; i++; continue; }
    const wordBefore = i > 0 && !/\s/.test(s[i - 1]);
    if (!inQuotes && (c === '|' || c === '<' || c === '>' || (c === '&' && (s[i + 1] === '&' || !wordBefore)))) {
      end(); i++; continue;
    }
    out += c; i++;
  }
  end();
  return lines;
}

// The C runtime's argument rules: blanks split outside quotes, " toggles quoting,
// "" inside quotes is a literal quote, and a run of n backslashes before a quote
// gives n/2 backslashes (odd n: plus a literal quote). Backslashes before anything
// else are literal, except in Chrome's format, where they come doubled.
function crtSplit(line: string, chrome: boolean): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (!inQuotes && (BLANKS.includes(c) || c === '\n')) {
      if (inWord) words.push(word);
      word = ''; inWord = false; i++; continue;
    }
    inWord = true;
    if (c === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        word += '\\'.repeat(n >> 1);
        if (n % 2) { word += '"'; i += n + 1; } else i += n;
      } else {
        word += '\\'.repeat(chrome ? Math.ceil(n / 2) : n);
        i += n;
      }
      continue;
    }
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { word += '"'; i += 2; continue; }
      inQuotes = !inQuotes; i++; continue;
    }
    word += c; i++;
  }
  if (inQuotes) throw new CurlError(UNCLOSED_QUOTE);
  if (inWord) words.push(word);
  return words;
}

const PS_ESCAPES = new Map<string, string>([
  ['n', '\n'], ['r', '\r'], ['t', '\t'], ['0', '\0'], ['a', '\x07'],
  ['b', '\b'], ['e', '\x1b'], ['f', '\f'], ['v', '\v'],
]);

export function powershellCommands(s: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => { if (inWord) words.push(legacyQuotes(word)); word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (BLANKS.includes(c)) { endWord(); i++; continue; }
    if (c === '\n') { endWord(); if (!nextLineIsOption(s, i + 1)) endCommand(); i++; continue; }
    if (c === '`') {
      const after = continuationEnd(s, i + 1);
      if (after >= 0) { i = after; continue; }
      const n = s[i + 1] ?? '';
      word += PS_ESCAPES.get(n) ?? n; inWord = true; i += 2; continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) throw new CurlError(UNCLOSED_QUOTE);
        if (s[j] === "'" && s[j + 1] === "'") { word += "'"; j += 2; continue; }
        if (s[j] === "'") break;
        word += s[j]; j++;
      }
      inWord = true; i = j + 1; continue;
    }
    if (c === '"') { const r = readPsDouble(s, i + 1); word += r.text; inWord = true; i = r.end; continue; }
    if (c === '$') { const r = readPsDollar(s, i); word += r.text; inWord = true; i = r.end; continue; }
    if (c === '#' && !inWord) { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '&' && !inWord && words.length === 0) { i++; continue; } // & curl.exe: the call operator
    if (c === '&' && inWord) { word += c; i++; continue; }
    if ('|;<>&'.includes(c)) { endCommand(); i++; continue; }
    word += c; inWord = true; i++;
  }
  endCommand();
  return commands;
}

function readPsDouble(s: string, start: number): { text: string; end: number } {
  let out = '';
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' && s[i + 1] === '"') { out += '"'; i += 2; continue; }
    if (c === '"') return { text: out, end: i + 1 };
    if (c === '`') { const n = s[i + 1] ?? ''; out += PS_ESCAPES.get(n) ?? n; i += 2; continue; }
    if (c === '$') { const r = readPsDollar(s, i); out += r.text; i = r.end; continue; }
    out += c; i++;
  }
  throw new CurlError(UNCLOSED_QUOTE);
}

// $env:NAME, ${env:NAME}, $NAME and ${NAME} are variables; $( ... ) runs a command.
function readPsDollar(s: string, i: number): { text: string; end: number } {
  if (s[i + 1] === '(') throw new CurlError(COMMAND_SUBSTITUTION);
  if (s[i + 1] === '{') {
    const close = s.indexOf('}', i + 2);
    if (close < 0) throw new CurlError(UNCLOSED_QUOTE);
    const name = SHELL_NAME_RE.exec(s.slice(i + 2, close).replace(/^env:/i, ''));
    return { text: name ? varMarker(name[0]) : s.slice(i, close + 1), end: close + 1 };
  }
  const env = /^\$env:([A-Za-z_][A-Za-z0-9_]*)/i.exec(s.slice(i, i + 256));
  if (env) return { text: varMarker(env[1]), end: i + env[0].length };
  const name = SHELL_NAME_RE.exec(s.slice(i + 1, i + 256));
  return name ? { text: varMarker(name[0]), end: i + 1 + name[0].length } : { text: '$', end: i + 1 };
}

// Windows PowerShell 5.1 dropped quotes inside arguments to native programs, so
// docs write '{\"name\":\"x\"}' and curl.exe's runtime turns \" into ". When every
// quote in an argument is written \", read them as plain quotes.
function legacyQuotes(w: string): string {
  return w.includes('\\"') && !/(^|[^\\])"/.test(w) ? w.replace(/\\"/g, '"') : w;
}
