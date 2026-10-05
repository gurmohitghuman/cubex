import { db } from './db';
import { stripControlChars } from './csv-safety';
import { stripInvisibleNameChars } from './name-safety';

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
// stripping here keeps writes and reads consistent. sanitizeColumnName() below
// strips the same chars at the import/HTTP boundary for defense in depth.
export function jsonPath(columnName: string): string {
  return `$."${columnName.replace(/["\\]/g, '')}"`;
}

// Normalize a user-supplied column name to something we can safely use as a
// SQLite JSON path key. Applied at the BOUNDARY where untrusted names enter
// (CSV import, HTTP API response mapping).
export function sanitizeColumnName(raw: string): string {
  let name = (raw ?? '').trim();
  // Strip the same path-unsafe chars jsonPath() strips ("\, "). A backslash in
  // a name (e.g. a Windows path "C:\files" pasted as a CSV header) otherwise
  // produces malformed row JSON — see jsonPath() above.
  name = name.replace(/["\\]/g, '');
  // Strip control + BIDI chars: this name becomes a visible column header / CSV
  // header, so a U+202E-style override would spoof how the header renders. This
  // path already transforms the name (unlike the reject-based table/sheet name
  // validators), so we strip here to stay consistent.
  // Trim again after: a hidden character could shield a space at either end.
  name = stripInvisibleNameChars(stripControlChars(name)).replace(/\s+/g, ' ').trim();
  if (name.length === 0) name = 'Column';
  if (name.length > 200) {
    // Don't cut through a surrogate pair (a lone half becomes U+FFFD in the
    // JSON path, so the column's cells would never match its name), and drop a
    // joiner or selector the cut left without its emoji.
    const cut = /[\uD800-\uDBFF]/.test(name[199]) ? 199 : 200;
    name = stripInvisibleNameChars(name.slice(0, cut)).trim();
  }
  return name;
}

// Shape of a row coming out of the `rows` table. `data` is a JSON string in
// the DB; callers usually want it parsed via parseRowData() below.
export interface RowDB {
  id: string;
  sheet_id: string;
  user_id: string;
  row_index: number;
  data: string;             // JSON: { columnName: value, ... }
  updated_at: string;
}

// Parse a row's JSON `data` blob to a plain object. Empty string and malformed
// JSON both fall back to {} — we never want this to throw upstream.
export function parseRowData(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

// Convert a list of DB rows into rowIndex → { columnName: value } map.
export function buildRowsMapFromRows(rows: RowDB[]): Map<number, Record<string, string>> {
  const map = new Map<number, Record<string, string>>();
  for (const r of rows) map.set(r.row_index, parseRowData(r.data));
  return map;
}

// Bulk upsert a batch of cells in a single transaction. Used by the cell-edit batch API.
export function upsertCellsBatch(
  sheetId: string,
  userId: string,
  updates: Array<{ rowIndex: number; columnName: string; value: string }>,
): void {
  if (updates.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO rows (id, sheet_id, user_id, row_index, data, updated_at)
    VALUES (?, ?, ?, ?, json_object(?, ?), datetime('now'))
    ON CONFLICT(sheet_id, user_id, row_index) DO UPDATE SET
      data = json_set(data, ?, ?),
      updated_at = datetime('now')
  `);
  const tx = db.transaction(() => {
    for (const u of updates) {
      stmt.run(
        crypto.randomUUID(),
        sheetId, userId, u.rowIndex,
        u.columnName, u.value,
        jsonPath(u.columnName), u.value,
      );
    }
  });
  tx();
}

// Delete ai_results / http_results that reference the given row_index values of
// a sheet. MUST be called whenever rows are physically removed (bulk row delete),
// or the per-row results become orphans bound to a stale row_index: a later
// physical sort compacts a DIFFERENT live row onto that index (orphan's
// scraped-data popup attaches to the wrong row), and a preview-commit upserts by
// that index and RESURRECTS the deleted row. Results carry no sheet_id of their
// own, so we scope through the owning run (ai_runs/http_runs.sheet_id).
//
// Caller should run this in the SAME transaction as the DELETE FROM rows so a
// crash can't leave rows gone but results dangling.
export function purgeResultsForRows(
  sheetId: string,
  userId: string,
  rowIndices: number[],
): void {
  if (rowIndices.length === 0) return;
  const ph = rowIndices.map(() => '?').join(',');
  db.prepare(`
    DELETE FROM ai_results
     WHERE user_id = ? AND row_index IN (${ph})
       AND run_id IN (SELECT id FROM ai_runs WHERE sheet_id = ? AND user_id = ?)
  `).run(userId, ...rowIndices, sheetId, userId);
  db.prepare(`
    DELETE FROM http_results
     WHERE user_id = ? AND row_index IN (${ph})
       AND run_id IN (SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ?)
  `).run(userId, ...rowIndices, sheetId, userId);
}
