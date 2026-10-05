// Shared JSONPath builder for the click-to-map JSON tree (used by BOTH the HTTP
// API modal and the webhook drawer). One builder so the client emits the exact
// dialect the server extractor (lib/jsonpath-extract.ts, jsonpath-plus) resolves.
//
// THE BUG THIS FIXES: the old tree built child paths as `${path}.${key}`, which
// breaks for keys containing dots/spaces/hyphens/quotes — common in third-party
// webhook payloads (e.g. "event.type", "first name", "x-id"). `$.event.type`
// would be read as a NESTED event.type object, silently extracting the wrong
// value (or nothing). We emit dot notation only for safe identifiers and bracket
// notation otherwise. This also fixes the existing HTTP feature.

// A "safe" object key: starts with a letter/underscore/$, then word chars/$.
// These are the keys jsonpath-plus resolves correctly with bare dot notation.
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Append an object key to a base path.
export function appendKey(basePath: string, key: string): string {
  if (SAFE_KEY.test(key)) return `${basePath}.${key}`;
  // Bracket-quote: escape backslashes and double-quotes so the path stays valid.
  const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${basePath}["${escaped}"]`;
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
  if (bracketKey) return bracketKey[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  // Last dotted key
  const dotKey = path.match(/\.([A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (dotKey) return dotKey[1];
  // Trailing array index
  const idx = path.match(/\[(\d+)\]$/);
  if (idx) return idx[1];
  return 'value';
}
