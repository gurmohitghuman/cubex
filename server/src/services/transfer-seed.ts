import { db } from '../lib/db';
import { SEED_COLUMN_NAME, SEED_ROW_COUNT } from '../lib/seed-sheet';

export function isPristineSeedSheet(sheetId: string, userId: string): boolean {
  const sheet = db.prepare(
    'SELECT column_order FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as { column_order: string | null } | undefined;
  if (!sheet) return false;
  let order: unknown;
  try { order = JSON.parse(sheet.column_order ?? 'null'); } catch { return false; }
  if (!Array.isArray(order) || order.length !== 1 || order[0] !== SEED_COLUMN_NAME) return false;
  const rows = db.prepare(
    'SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index',
  ).all(sheetId, userId) as Array<{ row_index: number; data: string }>;
  if (rows.length !== SEED_ROW_COUNT) return false;
  return rows.every((row, i) => {
    if (row.row_index !== i) return false;
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      return Object.keys(data).length === 1 && data[SEED_COLUMN_NAME] === '';
    } catch { return false; }
  });
}
