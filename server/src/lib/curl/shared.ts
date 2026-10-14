// What every "Paste a cURL command" module shares: the error a user sees, and
// the marker a shell variable ($KEY, ${KEY}, %KEY%, $env:KEY) travels as until
// request.ts turns it into a {{KEY}} reference. The markers are private-use
// characters, stripped from the input first and from what $'...' escapes decode
// to, so pasted text can't forge one.
// The parser never runs a shell and never expands a variable.

export class CurlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurlError';
  }
}

export const VAR_OPEN = '\uE000';
export const VAR_CLOSE = '\uE001';
export const varMarker = (name: string): string => `${VAR_OPEN}${name}${VAR_CLOSE}`;
export const VAR_MARKER_RE = /\uE000([A-Za-z_][A-Za-z0-9_]*)\uE001/g;
export const SHELL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

// Blanks that separate words outside quotes (a no-break space comes along when a
// command is copied from a web page).
export const BLANKS = ' \t\u00a0';

export const COMMAND_SUBSTITUTION =
  'This command runs another command inside it ($(...) or backticks). Replace that part with its value.';
export const UNCLOSED_QUOTE = "A quote isn't closed. Check that the whole command was pasted.";

// Pasted docs often lose the line-ending backslashes. A line that starts with an
// option still belongs to the command above it.
export function nextLineIsOption(s: string, i: number): boolean {
  let j = i;
  while (j < s.length && BLANKS.includes(s[j])) j++;
  return s[j] === '-';
}

// A continuation character (\ in bash, ` in PowerShell) followed only by blanks
// up to the line break: curl users mean "continue the line", so read it that way.
// Returns the index after the line break, or -1 when this isn't one.
export function continuationEnd(s: string, i: number): number {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  return s[j] === '\n' ? j + 1 : -1;
}
