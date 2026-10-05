import { MAX_SHEET_NAME_LENGTH } from './constants';
import { containsInvisibleNameChar } from './name-safety';

// Returns an error message if invalid, null if OK. Used by both create and rename
// sheet routes — keeps the rules in sync. Mirrors validateTableName. Case-insensitive
// per-table uniqueness is enforced separately (route conflict check + the
// UNIQUE(table_id, LOWER(name)) index from migration 029), not here.
export function validateSheetName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string') return 'Sheet name is required';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Sheet name cannot be empty';
  if (trimmed.length > MAX_SHEET_NAME_LENGTH) {
    return `Sheet name must be ${MAX_SHEET_NAME_LENGTH} characters or less`;
  }
  if (/[<>"]/.test(trimmed)) return 'Sheet names can\'t contain < > or "';
  if (containsInvisibleNameChar(trimmed)) return 'Sheet name contains invisible characters (such as zero-width spaces). Remove them and try again.';
  return null;
}
