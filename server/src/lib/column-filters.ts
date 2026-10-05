import { jsonPath } from './sql-rows';

// Server-side "text contains" filter builder — the text-search sibling of
// empty-filter.ts. Stored per-sheet (sheets.column_filters, migration 031) as
// JSON { col: { type: 'contains', value } } and applied in GET /data's SQL so a
// match beyond the loaded row window is reachable (the grid is windowed).
//
// Case-insensitive substring match. SQLite LIKE is ASCII-case-insensitive by
// default; we lower() BOTH sides so non-ASCII (e.g. accented) letters fold too.
// AND-joined with each other AND with the empty filter (Google-Sheets semantics,
// A row shows only if it passes every active column filter).

export interface ContainsFilter { type: 'contains'; value: string; }
export type ColumnFilters = Record<string, ContainsFilter>;

// Escape the user's value for a LIKE pattern: %, _ and the escape char itself
// become literals, so `50%` filters for the literal "50%" not "50<anything>".
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Tolerant parse — drops anything malformed so a bad/tampered value can't 500
// the read path (mirrors parseEmptyFilter). An empty/whitespace value is dropped
// (an empty "contains" is not a filter).
export function parseColumnFilters(raw: string | null | undefined): ColumnFilters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: ColumnFilters = {};
    for (const [col, cond] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof col !== 'string' || !col) continue;
      if (!cond || typeof cond !== 'object') continue;
      const c = cond as Record<string, unknown>;
      if (c.type === 'contains' && typeof c.value === 'string' && c.value.trim() !== '') {
        out[col] = { type: 'contains', value: c.value };
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Build AND-joined predicates + bound params. Returns {clause:'', params:[]}
// when empty so callers concatenate unconditionally (same contract as
// buildEmptyFilterSql). Each predicate: lower(cell) LIKE lower('%value%').
export function buildColumnFiltersSql(filters: ColumnFilters): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  for (const [col, cond] of Object.entries(filters)) {
    // coalesce so a missing key (NULL) is treated as '' — never matches a
    // non-empty needle, which is the intuitive result for "contains".
    parts.push(`lower(coalesce(json_extract(data, ?), '')) LIKE lower(?) ESCAPE '\\'`);
    params.push(jsonPath(col), `%${escapeLike(cond.value)}%`);
  }
  return parts.length === 0
    ? { clause: '', params: [] }
    : { clause: ' AND ' + parts.join(' AND '), params };
}
