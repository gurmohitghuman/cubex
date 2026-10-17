// Build a SQLite JSON path that references a single key by name, with the key
// quoted so dots, brackets, quotes, and spaces in the name are treated as part
// of the key rather than as JSON path syntax.
//
// Why this exists: every site that does `json_set(data, '$.' || ?, ?)` treats
// `?` as raw path text. A column name like "company.domain" becomes path
// "$.company.domain", which SQLite interprets as nested keys company → domain.
// CSV headers in the wild include dots, brackets, and quotes; without this
// helper, every such column silently writes to the wrong place.
//
// SQLite's JSON path accepts double-quoted keys: `$."company.domain"`. Two
// characters are unsafe INSIDE a quoted JSON path key and are stripped here:
//   - `"`  — SQLite does NOT accept the "" escape inside a quoted path key.
//   - `\`  — SQLite's path parser treats `\` as the start of an escape sequence
//            (e.g. `\x..`), so a literal backslash like `C:\xfiles` makes
//            json_set write MALFORMED JSON that every later json_extract /
//            JSON.parse rejects — silently soft-bricking the whole row. Stripping
//            (not doubling) is the only predictable fix: empirically `\\` still
//            throws "malformed JSON" on SQLite 3.53.x for some sequences, and
//            doubling would also desync the written key from the read key.
// This is the single choke point every read/write of a cell passes through, so
// stripping here keeps writes and reads consistent. sanitizeColumnName() (sql-rows.ts)
// strips the same chars at the import/HTTP boundary for defense in depth.
export function jsonPath(columnName: string): string {
  return `$."${columnName.replace(/["\\]/g, '')}"`;
}
