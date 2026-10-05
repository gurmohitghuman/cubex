// Column reorder — extracted verbatim from routes/sheets-columns-reorder.ts so
// the UI route and /api/v1 share one implementation (and one validation set:
// strings-only, no dups, no unknown columns, no omissions — a partial order
// would silently dump missing columns at the end on the next verified read).
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';

export type ColumnReorderOutcome = { ok: true } | { fail: 'invalid'; error: string };

// Caller has already verified sheet ownership.
export function reorderSheetColumns(
  sheetId: string,
  userId: string,
  columnOrder: unknown,
  opts: { bumpDataVersion?: boolean } = {},
): ColumnReorderOutcome {
  if (!Array.isArray(columnOrder)) return { fail: 'invalid', error: 'Column order array is required' };
  for (let i = 0; i < columnOrder.length; i++) {
    if (typeof columnOrder[i] !== 'string') {
      return { fail: 'invalid', error: `columnOrder[${i}] must be a string.` };
    }
  }
  const typedOrder = columnOrder as string[];

  const seen = new Set<string>();
  for (const c of typedOrder) {
    if (seen.has(c)) return { fail: 'invalid', error: `Duplicate column in order: "${c}".` };
    seen.add(c);
  }

  const existingNames = getSheetColumns(sheetId, userId);
  const existingSet = new Set(existingNames);
  const invalid = typedOrder.filter(col => !existingSet.has(col));
  if (invalid.length > 0) return { fail: 'invalid', error: `Invalid columns in order: ${invalid.join(', ')}` };

  const missing = existingNames.filter(col => !seen.has(col));
  if (missing.length > 0) {
    return { fail: 'invalid', error: `Column order must include every column. Missing: ${missing.join(', ')}` };
  }

  db.prepare(`
    UPDATE sheets SET column_order = ?, ${opts.bumpDataVersion ? 'data_version = data_version + 1, ' : ''}updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(JSON.stringify(typedOrder), sheetId, userId);

  return { ok: true };
}
