// Splits a pasted cURL command into curl's arguments, the way the shell it was
// written for would: bash (the default, and what browsers' "Copy as cURL" and API
// docs emit), Windows cmd (^ escapes; Chrome's "Copy as cURL (cmd)") or
// PowerShell (` continuations, curl.exe). Nothing is run or expanded: a shell
// variable becomes a marker (shared.ts), a $(...) or backtick is refused.
import { CURL_MAX_CHARS } from '../constants-curl';
import {
  BLANKS, COMMAND_SUBSTITUTION, CurlError, UNCLOSED_QUOTE, continuationEnd, nextLineIsOption,
} from './shared';
import { readAnsiC, readDollar, readDoubleQuoted } from './shell-strings';
import { cmdCommands, powershellCommands } from './tokenize-windows';

export type CurlDialect = 'bash' | 'cmd' | 'powershell';
export interface CurlCommand { args: string[]; dialect: CurlDialect; notes: string[] }

// A shell prompt copied along with the command: "$ curl", "% curl", "PS C:\> curl".
const PROMPT_RE = /^\s*(?:\$|%|>|#|PS[^>\n]*>|[A-Za-z]:\\[^>\n]*>)[ \t]+(?=curl)/i;
const CURL_WORD_RE = /^(?:.*[/\\])?curl(?:\.exe)?$/i;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function splitCurlCommand(raw: string): CurlCommand {
  if (typeof raw !== 'string' || !raw.trim()) throw new CurlError('Paste a cURL command first.');
  if (raw.length > CURL_MAX_CHARS) {
    throw new CurlError(`That command is longer than ${CURL_MAX_CHARS.toLocaleString('en-US')} characters.`);
  }
  const notes: string[] = [];
  let text = raw.replace(/[\uE000\uE001]/g, '').replace(/\r\n?/g, '\n').replace(PROMPT_RE, '');
  // Chat apps and docs editors curl the quotes. With no straight quote at all,
  // the curly ones were meant as quoting.
  if (!/['"]/.test(text) && /[\u2018\u2019\u201c\u201d]/.test(text)) {
    text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
    notes.push('Curly quotes were read as straight quotes.');
  }
  const dialect = detectDialect(text);
  const commands = dialect === 'cmd' ? cmdCommands(text)
    : dialect === 'powershell' ? powershellCommands(text) : bashCommands(text);
  for (const words of commands) {
    let k = 0;
    while (k < words.length && (ENV_ASSIGNMENT_RE.test(words[k]) || words[k] === 'sudo')) k++;
    if (k < words.length && CURL_WORD_RE.test(words[k])) {
      if (commands.length > 1) notes.push('Only the curl command was used. The rest of what you pasted was ignored.');
      return { args: words.slice(k + 1), dialect, notes };
    }
  }
  throw new CurlError("That doesn't look like a cURL command. Paste one that starts with curl.");
}

// Windows signs: a " ^" line ending or ^"-quoted arguments (cmd), a double-
// quoted argument that starts {"" or ["" (Edge doubles quotes: "{""a"":1}"), or
// a " `" line ending or $env: (PowerShell). Text inside a bash body rarely has them.
function detectDialect(t: string): CurlDialect {
  const caretQuotes = (t.match(/\^"/g) ?? []).length; // Chrome's ^"...^" comes in pairs
  if (/\s\^[ \t]*\n/.test(t) || (caretQuotes >= 2 && /(^|\s)\^"/.test(t)) || /(^|\s)"[[{]""/.test(t)) return 'cmd';
  if (/\s`[ \t]*\n/.test(t) || /\$env:/i.test(t)) return 'powershell';
  if (/^\s*curl\.exe\b/i.test(t)) return t.includes("'") ? 'powershell' : 'cmd';
  return 'bash';
}

// Bash rules: blanks split words; '...' is literal; "..." and $'...' per
// shell-strings.ts; \x outside quotes is x; backslash-newline continues the line.
// | ; && || < > end the command (so a trailing "| jq ." is dropped). A & inside a
// word is kept: an unquoted URL like ?a=1&b=2 is a common paste.
function bashCommands(s: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (BLANKS.includes(c)) { endWord(); i++; continue; }
    if (c === '\n') { endWord(); if (!nextLineIsOption(s, i + 1)) endCommand(); i++; continue; }
    if (c === '\\') {
      const after = continuationEnd(s, i + 1);
      if (after >= 0) { i = after; continue; }
      if (i + 1 < s.length) { word += s[i + 1]; inWord = true; }
      i += 2; continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) throw new CurlError(UNCLOSED_QUOTE);
      word += s.slice(i + 1, close); inWord = true; i = close + 1; continue;
    }
    if (c === '"') { const r = readDoubleQuoted(s, i + 1); word += r.text; inWord = true; i = r.end; continue; }
    if (c === '$' && s[i + 1] === "'") {
      const r = readAnsiC(s, i + 2); word += r.text; inWord = true; i = r.end; continue;
    }
    if (c === '$' && s[i + 1] === '"') { i++; continue; } // $"\u2026" is a plain "\u2026"
    if (c === '$') { const r = readDollar(s, i); word += r.text; inWord = true; i = r.end; continue; }
    if (c === '`') throw new CurlError(COMMAND_SUBSTITUTION);
    if (c === '#' && !inWord) { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '&' && inWord && s[i + 1] !== '&') { word += c; i++; continue; }
    if ('|;&<>'.includes(c)) {
      if ((c === '<' || c === '>') && /^\d+$/.test(word)) { word = ''; inWord = false; } // 2>&1
      endCommand(); i++; continue;
    }
    word += c; inWord = true; i++;
  }
  endCommand();
  return commands;
}
