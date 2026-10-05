import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { acquireLongPollHold, releaseLongPollHold } from '../lib/long-poll-holds';
import { sheetListKey } from '../lib/sheet-list-key';

// Lightweight per-sheet change-poll for out-of-band writers (webhook appends
// and every /api/v1 mutation — both bump sheets.data_version): the open grid
// long-polls /:id/changes?since=<dv>&since_rg=<rg> and the request RESOLVES
// when data_version > since OR (since_rg present and) row_generation moved.
// row_generation resolution matters because sort / CSV-replace re-mean every
// row_index WITHOUT necessarily bumping data_version (UI sort bumps only rg) —
// an open tab must learn that promptly, not at the 25s heartbeat.
//
// It NEVER streams row payloads — only the "something changed, reload" signal.
// The client picks the reload kind: rg moved → LOUD (indices re-meant; grid
// remount clears selection + overlays); dv only → SILENT (overlays un-flushed
// + recently-acked local edits). since_rg is optional (legacy clients omit it).
// since_sk (optional) is the table's tab-list key (lib/sheet-list-key.ts): the
// request also resolves when a sheet of the table was created, renamed,
// reordered or deleted, and every answer carries the current sheetsKey.
const router = express.Router();
router.use(authenticateToken);

// Hold the request open up to this long, then return the current version even if
// unchanged (a heartbeat). Well under the 65s keep-alive so proxies/Node don't
// kill it mid-flight. The client immediately re-polls — this is NOT a per-tick
// refetch of sheet data (which would trip the global limiter); it's one cheap
// integer read per poll cycle.
const MAX_HOLD_MS = 25_000;
const CHECK_INTERVAL_MS = 1_000;

// Concurrent-hold caps. Each held request keeps a socket + a 1s timer open for up
// to 25s; without a cap an authenticated user could open hundreds of holds and
// pin sockets/timers (a per-user resource-exhaustion vector on the shared event
// loop). Over a cap we DON'T hold — we return an immediate heartbeat so the
// client just re-polls a moment later. The per-user bound stops one runaway
// tab or script; the global bound protects the process.

type Version = { dataVersion: number; rowGeneration: number; sheetsKey: string | null };

function readVersion(sheetId: string, userId: string): Version | null {
  const row = db.prepare(
    'SELECT data_version AS dv, row_generation AS rg, table_id AS tid FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as { dv: number; rg: number; tid: string } | undefined;
  return row ? { dataVersion: row.dv, rowGeneration: row.rg, sheetsKey: sheetListKey(row.tid, userId) } : null;
}

router.get('/:id/changes', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });

  const since = parseInt(String(req.query.since ?? ''), 10);
  const sinceVersion = Number.isFinite(since) ? since : -1;
  const sinceRgRaw = parseInt(String(req.query.since_rg ?? ''), 10);
  const sinceRg = Number.isFinite(sinceRgRaw) ? sinceRgRaw : null;

  const sinceSk = typeof req.query.since_sk === 'string' && req.query.since_sk ? req.query.since_sk : null;

  const hasChanged = (v: Version): boolean =>
    v.dataVersion > sinceVersion || (sinceRg !== null && v.rowGeneration !== sinceRg)
    || (sinceSk !== null && v.sheetsKey !== sinceSk);

  const initial = readVersion(id, req.userId!);
  if (!initial) return res.status(404).json({ error: 'Sheet not found' });

  // Already ahead — return immediately (no hold).
  if (hasChanged(initial)) {
    return res.json({ ...initial, changed: true });
  }

  // Over the concurrent-hold cap → don't hold; return an immediate heartbeat so
  // the client re-polls shortly. Degrades gracefully under resource pressure.
  if (!acquireLongPollHold(req.userId!)) {
    return res.json({ ...initial, changed: false });
  }

  // Otherwise hold, re-checking on an interval until it advances or we time out.
  const deadline = Date.now() + MAX_HOLD_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let finished = false;

  const finish = (payload: Record<string, unknown>) => {
    if (finished) return;
    finished = true;
    if (timer) { clearInterval(timer); timer = null; }
    releaseLongPollHold(req.userId!);
    if (!res.writableEnded) res.json(payload);
  };

  timer = setInterval(() => {
    const cur = readVersion(id, req.userId!);
    // Sheet vanished mid-hold: echo the caller's own baselines so the client
    // sees "unchanged" (its next poll 404s and backs off) rather than a fake
    // rowGeneration:0 that would read as a structural change.
    if (!cur) return finish({ dataVersion: sinceVersion, rowGeneration: sinceRg ?? 0, sheetsKey: sinceSk, changed: false });
    if (hasChanged(cur)) return finish({ ...cur, changed: true });
    if (Date.now() >= deadline) return finish({ ...cur, changed: false });
  }, CHECK_INTERVAL_MS);

  // Stop holding if the client disconnects (closed tab / navigated away).
  req.on('close', () => {
    if (finished) return;
    finished = true;
    if (timer) { clearInterval(timer); timer = null; }
    releaseLongPollHold(req.userId!);
  });
});

export default router;
