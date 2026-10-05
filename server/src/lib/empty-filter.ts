import { jsonPath } from './sql-rows';

// Server-side empty-filter predicate builder. The client stores a per-sheet
// empty_filter (sheets.empty_filter, a JSON Record<col, 'empty'|'not_empty'>) and
// USED to apply it only over the loaded row window — so a match beyond the loaded
// rows was invisible AND unreachable (the scroll-trigger can't fire with few/zero
// visible rows). Applying the same predicate in GET /data's SQL makes the filter
// authoritative: the page, totalRows, and pagination all reflect the filtered set.
//
// Semantics MUST match the client (useSheetView.filteredRows):
//   - a cell is EMPTY when String(value).trim() === '' OR the key is absent.
//   - 'empty'     keeps rows where the cell is empty.
//   - 'not_empty' keeps rows where the cell is non-empty.
// SQLite: a missing key → json_extract returns NULL → COALESCE to '' → trim ''.
// A whitespace-only value → trim ''. So trim(coalesce(extract,'')) = '' is the
// exact mirror of the client's `s.trim() === ''`.

export type EmptyFilter = Record<string, 'empty' | 'not_empty'>;

// Parse the stored empty_filter JSON, keeping only well-formed entries. Anything
// malformed (legacy / tampered) yields {} so a bad value can't 500 the read path.
export function parseEmptyFilter(raw: string | null | undefined): EmptyFilter {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out: EmptyFilter = {};
    for (const [col, mode] of Object.entries(obj as Record<string, unknown>)) {
      if ((mode === 'empty' || mode === 'not_empty') && typeof col === 'string' && col) {
        out[col] = mode;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Build a SQL fragment (AND-joined predicates) + bound params for the filter.
// Returns { clause: '', params: [] } when there's no filter, so callers can
// concatenate unconditionally. Each predicate binds the column's JSON path.
export function buildEmptyFilterSql(filter: EmptyFilter): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  for (const [col, mode] of Object.entries(filter)) {
    // trim(coalesce(json_extract(data, ?), '')) — mirrors the client's trim().
    const expr = `trim(coalesce(json_extract(data, ?), ''))`;
    parts.push(mode === 'empty' ? `${expr} = ''` : `${expr} <> ''`);
    params.push(jsonPath(col));
  }
  return parts.length === 0
    ? { clause: '', params: [] }
    : { clause: ' AND ' + parts.join(' AND '), params };
}
