import { createHash } from 'crypto';
import { db } from './db';

// A short fingerprint of a table's name and its tab list (ids, names, order).
// The table GET hands it to the client and the sheet change-poll resolves when
// it moves, so a tab opened before a sheet was created, renamed, reordered or
// deleted elsewhere (the API, MCP, another tab) refreshes its tab bar. Null
// when the table is gone. Tables hold a handful of sheets, so this is one
// small indexed read.
export function sheetListKey(tableId: string, userId: string): string | null {
  const table = db.prepare('SELECT name FROM tables WHERE id = ? AND user_id = ?').get(tableId, userId) as
    { name: string } | undefined;
  if (!table) return null;
  const sheets = db.prepare(
    'SELECT id, name FROM sheets WHERE table_id = ? AND user_id = ? ORDER BY position, created_at',
  ).all(tableId, userId) as Array<{ id: string; name: string }>;
  const h = createHash('sha1').update(table.name);
  for (const s of sheets) h.update(`\u0000${s.id}\u0000${s.name}`);
  return h.digest('base64url').slice(0, 16);
}
