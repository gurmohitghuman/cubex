import { RELAXED_COLUMN_NAME_PATTERN, RESERVED_COLUMN_NAMES } from './constants';
import { sanitizeColumnName } from './sql-rows';
import { normalizeColumnName } from './prompt';

// Single source of truth for user-facing column-name acceptance, shared by EVERY
// column-creation path (manual add/rename, AI run, HTTP run, webhook mapping, CSV
// import). Names are PERMISSIVE like Google Sheets — symbols ("# Revenue", "$ ARR",
// "Q1 (2024)") are fine because storage double-quotes the JSON key (jsonPath) and
// /column references resolve via normalizeColumnName. We reject only what genuinely
// breaks: empty/symbol-only names (no /token), control/path-unsafe chars (already
// stripped by sanitizeColumnName), and the one reserved internal name (__rowIndex,
// which would overwrite the grid's row-identity field).

export interface ColumnNameOk { name: string }
export interface ColumnNameError { error: string }

// Sanitize a raw name (strip "/\, collapse whitespace, trim, cap 200) then validate
// it against the relaxed rule + reserved set. Returns the canonical name on success
// or a 400-ready error string. Use the RETURNED name as the stored key.
export function sanitizeAndValidateColumnName(raw: string): ColumnNameOk | ColumnNameError {
  const name = sanitizeColumnName(raw);
  if (RESERVED_COLUMN_NAMES.has(name)) {
    return { error: `"${name}" is reserved for Cubex's internal row identity. Choose a different name.` };
  }
  if (!RELAXED_COLUMN_NAME_PATTERN.test(name)) {
    return { error: 'A column name needs at least one letter A-Z or digit 0-9, which Cubex uses to reference it as /name (for example "城市 city" works, "城市" alone does not work yet).' };
  }
  return { name };
}

// Find a collision between `candidate` and `existing` column names on any of the
// axes that matter: exact, case-insensitive ("Domain" vs "domain"), and normalized
// /token ("# Revenue" vs "Revenue" → both /revenue, which makes /column resolution
// non-deterministic). `exclude` lets a rename skip comparing the column against
// itself. Returns the clashing existing name + which axis, or null if clear.
export function findColumnNameCollision(
  candidate: string,
  existing: Iterable<string>,
  opts: { exclude?: string } = {},
): { clash: string; kind: 'exact' | 'case' | 'token' } | null {
  const exclude = opts.exclude;
  const candLower = candidate.toLowerCase();
  const candNorm = normalizeColumnName(candidate);
  for (const c of existing) {
    if (exclude !== undefined && c === exclude) continue;
    if (c === candidate) return { clash: c, kind: 'exact' };
    if (c.toLowerCase() === candLower) return { clash: c, kind: 'case' };
    // Only a token collision when both produce a non-empty /token (symbol-only
    // names normalize to '' and are rejected by validate, never created).
    if (candNorm && normalizeColumnName(c) === candNorm) return { clash: c, kind: 'token' };
  }
  return null;
}

// Guard for a column-CREATION candidate that may legitimately REUSE its own
// existing column (AI/HTTP run start + rerun writing to "<name> (Output)"/
// "(Data)"). Returns a 400/409-ready message if the candidate would collide with
// a DIFFERENT existing column, or null when clear.
//
// The self-reuse fast-path is load-bearing: if the candidate already exists
// EXACTLY, the write targets its own column and creates nothing, so we must skip
// the collision scan. Otherwise, on a sheet that already holds a case/token
// variant (the state the pre-fix bug created — e.g. manual "Company Output"
// beside "Company (Output)"), findColumnNameCollision returns whichever match
// comes FIRST in the candidate list and would wrongly reject a legitimate
// refresh of the run's own column (fable review).
export function columnReuseCollision(
  candidate: string,
  existing: string[],
): string | null {
  if (existing.includes(candidate)) return null; // self-reuse: writes to its own column
  const collision = findColumnNameCollision(candidate, existing);
  return collision ? columnCollisionMessage(candidate, collision) : null;
}

// Build a user-facing 400 message for a collision, tailored to which axis tripped.
// `action` is the suggested fix tail (e.g. 'Choose a different name.' or the CSV
// 'Rename it in the CSV...' wording) so callers keep their own voice.
export function columnCollisionMessage(
  candidate: string,
  collision: { clash: string; kind: 'exact' | 'case' | 'token' },
  action = 'Choose a different name.',
): string {
  if (collision.kind === 'exact') return `A column named "${candidate}" already exists. ${action}`;
  if (collision.kind === 'case') {
    return `A column named "${collision.clash}" already exists (names are case-insensitive). ${action}`;
  }
  return `"${candidate}" and the existing column "${collision.clash}" both reference the same /column token (/${normalizeColumnName(candidate)}). ${action}`;
}
