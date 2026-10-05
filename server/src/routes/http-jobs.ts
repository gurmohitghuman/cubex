import express from 'express';
import { db } from '../lib/db';
import { authenticateUser } from '../lib/auth';
import { writeSSEHeaders } from '../lib/sse';
import { acquireSSESlot, SSE_MAX_PER_USER } from '../lib/sse-limits';
import { httpResultCellValues } from '../lib/http-cell-values';
import { type HTTPAPIConfig } from '../lib/http-request';

// HTTP run SSE stream only — pause/resume/cancel + run reads moved to
// http-control.ts (thin wrappers over services/run-lifecycle.ts).
const router = express.Router();

// SSE for live progress. Same DB-tail pattern as the AI SSE endpoint — worker
// threads can't directly notify connected clients, so each SSE client polls the DB
// on its own ~400ms interval and emits deltas. Loop ends on terminal status +
// drained results, or on client disconnect.
const SSE_POLL_MS = 400;

router.get('/jobs/:id/stream', (req, res) => {
  // SSE auth via the HttpOnly session cookie. See ai routes for rationale.
  const token = (req as any).cookies?.cubex_session as string | undefined;
  if (!token) return res.status(401).json({ error: 'Access token required' });
  // authenticateUser enforces the session epoch too (see ai-stream.ts note on
  // the open-stream gap).
  const userId = authenticateUser(token);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });

  const { id } = req.params;
  const run = db.prepare('SELECT user_id, config, master_column_name FROM http_runs WHERE id = ?')
    .get(id) as { user_id: string; config: string | null; master_column_name: string | null } | undefined;
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

  // Column names this run targets — needed to reconstruct the exact cell strings
  // for the live 'result' events (empty/failed rows write per-mapping markers, not
  // field values). Parsed ONCE at stream open; config is immutable for a run.
  let mappingColumns: string[] = [];
  try {
    const cfg = run.config ? (JSON.parse(run.config) as HTTPAPIConfig) : null;
    mappingColumns = cfg?.responseMapping?.map(m => m.columnName) ?? [];
  } catch { mappingColumns = []; }
  const masterColumn = run.master_column_name;

  // Per-user SSE cap (see ai-stream.ts for rationale).
  const closeStream = () => { clearInterval(timer); try { res.end(); } catch {} };
  const lease = acquireSSESlot(userId, res, closeStream);
  if (!lease) {
    return res.status(429).json({
      error: `Too many open streams for this account (max ${SSE_MAX_PER_USER}). Close some tabs and retry.`,
    });
  }

  writeSSEHeaders(res);
  res.write(`data: ${JSON.stringify({ type: 'connected', runId: id })}\n\n`);

  // Idempotent cleanup wired BEFORE the immediate tick() — see ai-stream.ts: the
  // first tick can synchronously res.end() on a terminal/missing run, and Node's
  // async 'close' would race a later-registered handler, leaking the lease.
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(timer);
    lease.release();
  };
  req.once('close', cleanup);
  res.once('close', cleanup);

  // Cursor by ROWID, not (created_at, id) — see ai-stream.ts for the full
  // rationale. created_at is 1-second granularity and id is a random uuidv4, so a
  // (created_at, id) cursor skips a same-second row inserted with a lower uuid
  // after that second was already partially cursored. rowid is monotonic insert
  // order (http_results is a rowid table), draining every row exactly once.
  let lastRowid = 0;
  let lastStatus = '';
  let lastProcessed = -1;

  const tick = () => {
    try {
      const r = db.prepare('SELECT status, processed_rows, total_rows, error_message FROM http_runs WHERE id = ?')
        .get(id) as { status: string; processed_rows: number; total_rows: number; error_message: string | null } | undefined;
      if (!r) { clearInterval(timer); try { res.end(); } catch {} return; }

      const newResults = db.prepare(`
        SELECT rowid AS cursor, id, row_index, status, error_message, extracted_fields
        FROM http_results
        WHERE run_id = ? AND rowid > ?
        ORDER BY rowid ASC
        LIMIT 200
      `).all(id, lastRowid) as Array<{
        cursor: number; id: string; row_index: number; status: string; error_message: string | null;
        extracted_fields: string | null;
      }>;

      for (const row of newResults) {
        // Reconstruct the exact cell strings the worker persisted (extracted
        // values / ⏭️ No data / ❌ Error + master column) so the live grid matches
        // the saved state. Without extractedFields the client paints nothing and
        // cells stay on '⏳ Processing...' until a full reload (M12).
        let extractedFields: Record<string, unknown> = {};
        try { extractedFields = row.extracted_fields ? JSON.parse(row.extracted_fields) : {}; } catch { /* {} */ }
        const cellValues = httpResultCellValues({
          status: row.status, extractedFields, mappingColumns, masterColumn,
        });
        res.write(`data: ${JSON.stringify({
          type: 'result', rowIndex: row.row_index, status: row.status,
          resultId: row.id, errorMessage: row.error_message || undefined,
          extractedFields: cellValues,
        })}\n\n`);
        lastRowid = row.cursor;
      }

      if (r.processed_rows !== lastProcessed) {
        res.write(`data: ${JSON.stringify({ type: 'progress', completed: r.processed_rows, total: r.total_rows })}\n\n`);
        lastProcessed = r.processed_rows;
      }
      const terminal = r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled';
      // Defer a TERMINAL status until the backlog is drained — see ai-stream.ts.
      // The client closes its EventSource on 'completed'/'failed'/'cancelled', so
      // emitting it with rows still queued abandons their live 'result' events.
      const statusReadyToEmit = !terminal || newResults.length === 0;
      if (r.status !== lastStatus && statusReadyToEmit) {
        // Carry the recorded failure reason so the client toast shows it instead
        // of "Unknown error" (L14). Only meaningful for 'failed'; omitted otherwise.
        res.write(`data: ${JSON.stringify({
          type: 'status', status: r.status,
          error: r.status === 'failed' ? (r.error_message || undefined) : undefined,
        })}\n\n`);
        lastStatus = r.status;
      }

      if (terminal && newResults.length === 0) { clearInterval(timer); try { res.end(); } catch {} }
    } catch (err) {
      console.error('HTTP SSE poll error:', err);
      clearInterval(timer);
      try { res.end(); } catch {}
    }
  };

  // Declare the interval before the immediate tick() (TDZ — see ai-stream.ts).
  // Cleanup is wired above, so a terminal-on-connect res.end() here is safely caught.
  const timer = setInterval(tick, SSE_POLL_MS);
  tick();
});

export default router;
