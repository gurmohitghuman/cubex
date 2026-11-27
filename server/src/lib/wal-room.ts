// The frames the WAL may reach while the checkpoint worker copies it back: WAL_BULK_ROOM_SHARE of
// journal_size_limit (none set: lib/db.ts's), about 14,600 frames at 64 MB and 4 KB pages. A bulk writer's pause is
// fitted to it (lib/bulk-slices.ts), and once the WAL watch runs (lib/wal-watch.ts) SQLite's own checkpoint waits for
// it on every connection (lib/db.ts), as a backstop.
import type { Database } from 'better-sqlite3';
import { DB_WAL_SIZE_LIMIT, WAL_BULK_ROOM_SHARE } from './constants';

export function walRoomFrames(conn: Database): number {
  const limit = conn.pragma('journal_size_limit', { simple: true }) as number;
  const page = conn.pragma('page_size', { simple: true }) as number;
  return Math.floor((WAL_BULK_ROOM_SHARE * (limit > 0 ? limit : DB_WAL_SIZE_LIMIT)) / (page + 24));
}
