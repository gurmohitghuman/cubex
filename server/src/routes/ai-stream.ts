import express from 'express';
import { db } from '../lib/db';
import { authenticateUser } from '../lib/auth';
import { writeSSEHeaders } from '../lib/sse';
import { acquireSSESlot, SSE_MAX_PER_USER } from '../lib/sse-limits';
import { aiDataCellSummary, parseScrapedData } from '../lib/ai-data-cell';

const router = express.Router();

// SSE for live updates (DB-tail poll).
//
// The worker that produces results runs in a Sidequest worker thread, which can't
// share JS state with the API process. Instead of an in-memory pubsub, we tail the
// DB: for each connected SSE client, every ~400ms we read ai_runs.status +
// processed_rows and ai_results > lastSeen, and emit deltas. The poll terminates
// when the run hits a terminal status AND every result has been emitted, OR when
// the client disconnects.

const SSE_POLL_MS = 400;

router.get('/runs/:id/stream', (req, res) => {
  // SSE auth via the HttpOnly session cookie. EventSource (browser) sends cookies
  // automatically when the client constructs it with `{withCredentials: true}`. We
  // deliberately do NOT accept a token in the URL — tokens in URL query strings
  // leak to access logs, browser history, and referrer headers.
  const token = (req as any).cookies?.cubex_session as string | undefined;
  if (!token) return res.status(401).json({ error: 'Access token required' });
  // authenticateUser also enforces the session epoch (revoked on password
  // reset). NOTE: this gates NEW stream connections; an already-open stream
  // keeps flowing until it next reconnects. Acceptable — a revoked token can't
  // open a new stream, and streams self-close at MAX_LIFETIME_MS.
  const userId = authenticateUser(token);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });

  const { id } = req.params;
  const run = db.prepare('SELECT user_id, status FROM ai_runs WHERE id = ?').get(id) as
    | { user_id: string; status: string } | undefined;
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

  // Per-user SSE cap. Without this a single authenticated user can open
  // unbounded EventSource connections (curl, custom JS — the browser's ~6
  // per-page limit doesn't apply outside the browser) and exhaust FDs.
  const closeStream = () => { clearInterval(timer); try { res.end(); } catch {} };
  const lease = acquireSSESlot(userId, res, closeStream);
  if (!lease) {
    return res.status(429).json({
      error: `Too many open streams for this account (max ${SSE_MAX_PER_USER}). Close some tabs and retry.`,
    });
  }

  writeSSEHeaders(res);
  res.write(`data: ${JSON.stringify({ type: 'connected', runId: id })}\n\n`);

  // Idempotent cleanup, wired BEFORE the immediate tick(). The first tick can
  // synchronously res.end() on a missing/terminal run; Node emits 'close'
  // asynchronously, so registering AFTER tick() races that emit and can miss it —
  // leaking the SSE lease. Guard + listen on both req and res 'close' so
  // whichever fires first runs cleanup exactly once.
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(timer);
    lease.release();
  };
  req.once('close', cleanup);
  res.once('close', cleanup);

  // Cursor by ROWID, not (created_at, id). ai_results.created_at has 1-SECOND
  // granularity and id is a RANDOM uuidv4 — so a (created_at, id) cursor orders
  // same-second rows by random uuid. On a fast run (concurrency up to 100), a row
  // inserted into an already-partially-cursored second with a uuid LOWER than the
  // last one emitted is skipped forever (`id > lastId` never matches it) — its
  // live 'result' event never fires and the cell stays '⏳ Processing...' until a
  // reload. rowid is monotonic in true INSERT order (ai_results is a rowid table:
  // `id TEXT PRIMARY KEY`, not WITHOUT ROWID), so `rowid > ?` drains every row
  // exactly once regardless of timestamp ties or insert concurrency.
  let lastRowid = 0;
  let lastStatus = '';
  let lastProcessed = -1;

  const tick = () => {
    try {
      const r = db.prepare(
        'SELECT status, processed_rows, total_rows, column_name, use_openrouter_web_search, error_message, output_columns FROM ai_runs WHERE id = ?',
      ).get(id) as { status: string; processed_rows: number; total_rows: number; column_name: string; use_openrouter_web_search: number; error_message: string | null; output_columns: string | null } | undefined;
      if (!r) { clearInterval(timer); try { res.end(); } catch {} return; }

      const newResults = db.prepare(`
        SELECT rowid AS cursor, id, row_index, output_value, status, error_message, scraped_data
        FROM ai_results
        WHERE run_id = ? AND rowid > ?
        ORDER BY rowid ASC
        LIMIT 200
      `).all(id, lastRowid) as Array<{
        cursor: number; id: string; row_index: number; output_value: string;
        status: string; error_message: string | null; scraped_data: string | null;
      }>;

      const needsDataColumn = !!r.use_openrouter_web_search;
      for (const row of newResults) {
        // Structured (multi-column) run: output_value is a raw JSON object, not a
        // single cell value — streaming it into one column would show a JSON blob.
        // Its N typed columns (and "(Data)") update via the sheet live-update poll:
        // each row's write bumps data_version (ai-row-writers-multi.ts). Still
        // advance the cursor so progress + terminal logic proceed.
        if (r.output_columns) { lastRowid = row.cursor; continue; }
        // Output column event
        res.write(`data: ${JSON.stringify({
          type: 'result',
          rowIndex: row.row_index,
          columnName: r.column_name,
          outputValue: row.status === 'failed' ? '' : row.output_value,
          status: row.status,
          resultId: row.id,
          errorMessage: row.error_message || undefined,
          hasScrapedData: !!row.scraped_data,
        })}\n\n`);
        // Data column event — only emit when the run created a (Data) column.
        if (needsDataColumn) {
          const dataColName = r.column_name.endsWith(' (Output)')
            ? r.column_name.replace(/ \(Output\)$/, ' (Data)')
            : `${r.column_name} (Data)`;
          // Reconstruct the SAME '📊 Searched N sources: …' breadcrumb the worker
          // persisted (from scraped_data) instead of always sending '' — which
          // blanked a populated (Data) cell live until a reload re-fetched it (L9).
          const dataValue = row.status === 'failed'
            ? '❌ Error'
            : aiDataCellSummary(parseScrapedData(row.scraped_data));
          res.write(`data: ${JSON.stringify({
            type: 'result',
            rowIndex: row.row_index,
            columnName: dataColName,
            outputValue: dataValue,
            status: row.status,
          })}\n\n`);
        }
        lastRowid = row.cursor;
      }

      if (r.processed_rows !== lastProcessed) {
        res.write(`data: ${JSON.stringify({
          type: 'progress', completed: r.processed_rows, total: r.total_rows,
        })}\n\n`);
        lastProcessed = r.processed_rows;
      }
      const terminal = r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled';
      // Defer a TERMINAL status event until the result backlog is fully drained
      // (this tick returned no new rows). The client closes its EventSource the
      // instant it sees 'completed'/'failed'/'cancelled' (sseHelpers handleTerminalStatus),
      // so emitting it while rows are still queued (terminal + newResults.length > 0)
      // abandons those live 'result' events — cells stuck '⏳ Processing...' until
      // the post-run reload, which only refetches the loaded window. Non-terminal
      // transitions (running→paused) still emit immediately: the user needs to see
      // the pause now, and there's no close to race. This pairs with the close guard
      // below — status + close land on the same drained tick.
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

      if (terminal && newResults.length === 0) {
        // Backlog drained AND terminal status emitted above — safe to close.
        clearInterval(timer);
        try { res.end(); } catch {}
      }
    } catch (err) {
      console.error('AI SSE poll error:', err);
      clearInterval(timer);
      try { res.end(); } catch {}
    }
  };

  // Declare the interval BEFORE the immediate tick(): tick() references `timer`
  // (clearInterval on a missing/terminal run), so calling it before `const timer`
  // is initialized throws a TDZ ReferenceError. Setting the interval first is
  // harmless (it won't fire for SSE_POLL_MS). Cleanup is already wired above, so a
  // terminal-on-connect res.end() in this immediate tick() is safely caught.
  const timer = setInterval(tick, SSE_POLL_MS);
  // Fire one tick immediately so the client gets the current state without waiting
  // for the first interval.
  tick();
});

export default router;
