// What the release check keeps in settings (migration 058): whether it is on, the last good answer and
// when the last check was sent. services/release-check.ts asks GitHub; this only reads and writes.
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';

export interface LatestRelease {
  version: string;              // "v0.8.13"
  published_at: string | null;  // ISO time, as GitHub gave it
  checked_at: string;           // ISO time the check that found it went out (its release_tried_at)
}
export interface ReleaseState { updateCheck: boolean; latest: LatestRelease | null; triedAt: string | null }

function parseLatest(text: string | null): LatestRelease | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<LatestRelease>;
    if (typeof v.version !== 'string' || typeof v.checked_at !== 'string') return null;
    return { version: v.version, published_at: typeof v.published_at === 'string' ? v.published_at : null,
      checked_at: v.checked_at };
  } catch { return null; }
}

// No settings row yet: the check is on and nothing was asked.
export function readReleaseState(userId: string): ReleaseState {
  const row = db.prepare('SELECT update_check, latest_release, release_tried_at FROM settings WHERE user_id = ?')
    .get(userId) as { update_check: number; latest_release: string | null; release_tried_at: string | null }
    | undefined;
  if (!row) return { updateCheck: true, latest: null, triedAt: null };
  return { updateCheck: row.update_check === 1, latest: parseLatest(row.latest_release),
    triedAt: row.release_tried_at };
}

const ensureRow = (userId: string) =>
  db.prepare('INSERT INTO settings (id, user_id) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING').run(uuidv4(), userId);

// Turning the check off deletes the kept answer, so only the running version shows, and forgets when the
// last check went out: turned on again, "Check now" asks at once instead of answering from nothing.
export function setUpdateCheck(userId: string, on: boolean): void {
  db.transaction(() => {
    ensureRow(userId);
    db.prepare(`UPDATE settings SET update_check = ?, latest_release = CASE WHEN ? = 1 THEN latest_release END,
      release_tried_at = CASE WHEN ? = 1 THEN release_tried_at END, updated_at = datetime('now')
      WHERE user_id = ?`).run(on ? 1 : 0, on ? 1 : 0, on ? 1 : 0, userId);
  }).immediate();
}

// The accounts due an automatic check: the check on, and none sent since `since` (ISO).
export function dueForReleaseCheck(since: string): string[] {
  return (db.prepare(`SELECT u.id FROM users u LEFT JOIN settings s ON s.user_id = u.id
    WHERE COALESCE(s.update_check, 1) = 1 AND (s.release_tried_at IS NULL OR s.release_tried_at < ?)`)
    .all(since) as Array<{ id: string }>).map(r => r.id);
}

// A check was sent at `triedAt`. A good answer replaces the kept one; a failed one (null) leaves it as it
// was. Neither is recorded when the check was turned off meanwhile.
export function keepReleaseAnswer(userId: string, latest: LatestRelease | null, triedAt: string): void {
  db.transaction(() => {
    ensureRow(userId);
    db.prepare('UPDATE settings SET release_tried_at = ? WHERE user_id = ? AND update_check = 1').run(triedAt, userId);
    if (latest) {
      db.prepare('UPDATE settings SET latest_release = ? WHERE user_id = ? AND update_check = 1')
        .run(JSON.stringify(latest), userId);
    }
  }).immediate();
}
