// The sheets a lookup column can look in, for the app's Lookup dialog (a pure
// read): every other sheet of the account, any table, with its columns.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';

export interface LookupTarget {
  sheetId: string; sheetName: string; tableId: string; tableName: string; columns: string[];
}

export function lookupTargets(userId: string, sheetId: string): LookupTarget[] {
  const sheets = db.prepare(`SELECT s.id, s.name, s.table_id AS tableId, t.name AS tableName
    FROM sheets s JOIN tables t ON t.id = s.table_id
    WHERE s.user_id = ? AND s.id <> ? AND s.trash_id IS NULL ORDER BY t.name COLLATE NOCASE, s.position, s.name`)
    .all(userId, sheetId) as Array<{ id: string; name: string; tableId: string; tableName: string }>;
  return sheets.map(s => ({
    sheetId: s.id, sheetName: s.name, tableId: s.tableId, tableName: s.tableName,
    columns: getSheetColumns(s.id, userId, false),
  }));
}
