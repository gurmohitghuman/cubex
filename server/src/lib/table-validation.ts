import { MAX_TABLE_NAME_LENGTH } from './constants';
import { containsInvisibleNameChar } from './name-safety';

// Returns an error message if invalid, null if OK. Used by both POST and PUT
// table routes — keeps the rules in sync between create and rename.
export function validateTableName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string') return 'Table name is required';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Table name cannot be empty';
  if (trimmed.length > MAX_TABLE_NAME_LENGTH) {
    return `Table name must be ${MAX_TABLE_NAME_LENGTH} characters or less`;
  }
  if (/[<>"]/.test(trimmed)) return 'Table names can\'t contain < > or "';
  if (containsInvisibleNameChar(trimmed)) return 'Table name contains invisible characters (such as zero-width spaces). Remove them and try again.';
  return null;
}
