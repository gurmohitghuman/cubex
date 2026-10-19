// Shared JSONPath builder for the click-to-map JSON tree (used by the answer
// panel, the HTTP API modal and the webhook drawer). One builder so the client
// emits the exact dialect the server reads (lib/jsonpath-literal.ts): `$`, then
// `.name` for a plain identifier, `["key"]` for any other key, `[n]` for an index.
//
// Keys with dots/spaces/hyphens/quotes are common in third-party payloads (e.g.
// "event.type", "first name", "x-id"): `$.event.type` would read a NESTED
// event.type object, so we emit dot notation only for safe identifiers and
// bracket notation otherwise. Inside the brackets a key is written the way JSON
// writes a string: backslash and quote escaped, controls as backslash n/t/r/b/f,
// and every character the tree treats as hidden (hidden-chars.ts) as backslash
// u and four hex digits, so a copied path is plain visible text that pastes
// whole. The server decodes it the same way (unescapeKey there).
import { BS, codePointAt, isHiddenAstral, isHiddenBmp, unitEscape } from './hidden-chars'

// A "safe" object key: starts with a letter/underscore/$, then word chars/$.
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SHORT: Record<number, string> = { 8: 'b', 9: 't', 10: 'n', 12: 'f', 13: 'r' };
const SHORT_BACK: Record<string, number> = { b: 8, t: 9, n: 10, f: 12, r: 13 };

// Append an object key to a base path.
export function appendKey(basePath: string, key: string): string {
  if (SAFE_KEY.test(key)) return `${basePath}.${key}`;
  return `${basePath}["${escapeKey(key)}"]`;
}

export function escapeKey(key: string): string {
  let out = '';
  for (let i = 0; i < key.length;) {
    const { cp, width, lone } = codePointAt(key, i);
    const c = key.charCodeAt(i);
    if (c === 92 || c === 34) out += BS + key[i];
    else if (SHORT[c]) out += BS + SHORT[c];
    else if (lone || (width === 1 && isHiddenBmp(c))) out += unitEscape(c);
    else if (width === 2 && isHiddenAstral(cp)) out += unitEscape(c) + unitEscape(key.charCodeAt(i + 1));
    else out += key.slice(i, i + width);
    i += width;
  }
  return out;
}

// A bracketed key's text back to the key: backslash u and four hex digits is
// that unit, backslash n/t/r/b/f the control, backslash and any other character
// that character. Raw characters stay as they are (paths saved before keys were
// escaped like this hold them).
export function unescapeKey(text: string): string {
  if (!text.includes(BS)) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 92 || i + 1 >= text.length) { out += text[i]; continue; }
    const next = text[i + 1];
    const hex = next === 'u' ? text.slice(i + 2, i + 6) : '';
    if (/^[0-9A-Fa-f]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; continue; }
    out += next in SHORT_BACK ? String.fromCharCode(SHORT_BACK[next]) : next;
    i++;
  }
  return out;
}

// Append an array index to a base path.
export function appendIndex(basePath: string, index: number): string {
  return `${basePath}[${index}]`;
}

// Derive a sensible default COLUMN name from a leaf's full path — the last key
// segment (bracket-quoted or dotted) or array index. e.g.
//   $.data["first name"] -> "first name";  $.items[0].sku -> "sku";  $ -> "value"
export function defaultColumnName(path: string): string {
  // Last bracket-quoted key: ["...."]
  const bracketKey = path.match(/\["((?:[^"\\]|\\.)*)"\]$/);
  if (bracketKey) return unescapeKey(bracketKey[1]);
  // Last dotted key
  const dotKey = path.match(/\.([A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (dotKey) return dotKey[1];
  // Trailing array index
  const idx = path.match(/\[(\d+)\]$/);
  if (idx) return idx[1];
  return 'value';
}
