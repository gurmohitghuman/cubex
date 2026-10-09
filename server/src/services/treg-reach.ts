// Whether treg answered Cubex's last call (a tool call in a run, or the
// Settings key test), for /api/health: no network call of its own. Kept on the
// settings row (runs call treg from the job process, so memory won't do) and
// written only when it changes, so a run's calls don't each write.
import { db } from '../lib/db';

export type TregReach = 'ok' | 'unreachable';

// `answered`: any answer from treg itself, a refusal included. No answer (a
// network error or timeout, a body cut off) and a 5xx that carries neither a
// call id nor treg's error header count as unreachable (lib/enrich-errors.ts).
export function noteTregReach(userId: string, answered: boolean): void {
  const reach: TregReach = answered ? 'ok' : 'unreachable';
  try {
    const now = db.prepare('SELECT treg_reach FROM settings WHERE user_id = ?').pluck().get(userId);
    if (now === reach) return;
    db.prepare(`UPDATE settings SET treg_reach = ?, treg_reach_since = datetime('now') WHERE user_id = ?`)
      .run(reach, userId);
  } catch (err) {
    console.error('Recording whether treg answered failed:', err);
  }
}

export function tregAnswered(a: {
  status: number | null; incomplete?: boolean; callId: string | null; tregError: boolean;
}): boolean {
  if (a.status === null || a.incomplete) return false;
  return !(a.status >= 500 && !a.callId && !a.tregError);
}

// The account's last outcome and since when (ISO), or null before any call
// or without a saved key (treg isn't in use then).
export function tregReach(): { treg: TregReach; since: string } | null {
  const r = db.prepare(`SELECT s.treg_reach AS reach, s.treg_reach_since AS since FROM settings s
    JOIN users u ON u.id = s.user_id
    WHERE s.treg_reach IS NOT NULL AND s.treg_token_encrypted IS NOT NULL LIMIT 1`).get() as
    { reach: TregReach; since: string } | undefined;
  return r ? { treg: r.reach, since: `${r.since.replace(' ', 'T')}Z` } : null;
}
