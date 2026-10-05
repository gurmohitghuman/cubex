import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { upsertCellsBatch } from '../lib/sql-helpers';
import { clampCellChars } from '../lib/csv-safety';
import { CELL_MAX_ENRICHMENT } from '../lib/constants';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { type AIRunRow } from '../services/ai-runner';

const router = express.Router();
router.use(authenticateToken);

router.put('/results/:id', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { value, status } = req.body as { value?: unknown; status?: unknown };
    // Type-guard the body. value:{} or value:[1,2] would crash better-sqlite3 with a
    // generic 500; an unrestricted status string would let a client write any value
    // into ai_results.status (which the commit handler reads via WHERE status='accepted').
    if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
    const ALLOWED_STATUSES = ['accepted', 'rejected', 'pending'] as const;
    if (typeof status !== 'string' || !ALLOWED_STATUSES.includes(status as any)) {
      return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
    }
    // Clamp to the enrichment cell cap (P2-8) — this is AI output, and the commit
    // handler below writes output_value straight into rows.data via
    // upsertCellsBatch, so an unbounded value here is an unbounded cell (this
    // was a missed write path). Truncate (don't reject) like the run
    // worker; store the clamped value so commit reads the capped string.
    const clampedValue = clampCellChars(value, CELL_MAX_ENRICHMENT);
    const result = db.prepare(`
      UPDATE ai_results SET output_value = ?, status = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(clampedValue, status, id, req.userId!);
    if (result.changes === 0) return res.status(404).json({ error: 'AI result not found' });
    res.json({ message: 'Result updated successfully' });
  } catch (error) {
    console.error('Update AI result error:', error);
    res.status(500).json({ error: 'Failed to update result' });
  }
});

router.post('/runs/:id/commit', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const run = db.prepare('SELECT * FROM ai_runs WHERE id = ? AND user_id = ?')
      .get(id, req.userId!) as AIRunRow | undefined;
    if (!run) return res.status(404).json({ error: 'AI run not found' });

    // Commit writes cells by row_index and column name, so it waits out a sort,
    // import or column rewrite (lib/sheet-busy.ts) like every other cell write.
    const busy = sheetBusyWith(run.sheet_id);
    if (busy) return res.status(409).json({ error: busyMessage(busy), busy: true });

    // Refuse to commit while the run is still active. A pending/running/paused
    // run has a (possibly paused) worker that writes results straight into
    // rows.data per row (services/ai-row.ts) — committing accepted cells now
    // would race that worker, which keeps overwriting the same column_name as it
    // processes the remaining rows. The UI only exposes commit after 'completed',
    // but the API had no guard, so a direct call (or a cancel/commit edge) could
    // smuggle a commit past a live run. Only terminal runs are safe to commit.
    if (run.status === 'pending' || run.status === 'running' || run.status === 'paused') {
      return res.status(409).json({ error: 'Cannot commit while the run is still active. Wait for it to finish, or cancel it first.' });
    }

    // Refuse to commit a SUPERSEDED run. A rerun creates a NEW ai_runs row with the
    // same (sheet_id, column_name) and a later created_at (ai-run-rerun.ts); the
    // worker writes its results straight into rows.data. If an older completed run is
    // then committed (e.g. a stale tab still showing its preview), its accepted cells
    // would overwrite the values the newer run already wrote. Only the latest run for
    // this (sheet_id, column_name) may commit. Tie-break on id so two runs sharing a
    // created_at second can't both consider themselves latest.
    const latest = db.prepare(`
      SELECT id FROM ai_runs
      WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(run.sheet_id, req.userId!, run.column_name) as { id: string } | undefined;
    if (latest && latest.id !== run.id) {
      return res.status(409).json({ error: 'This run has been superseded by a newer run on the same column. Commit the latest run instead.' });
    }

    // Only commit results whose row still exists. upsertCellsBatch is an
    // INSERT…ON CONFLICT, so an accepted result for a since-deleted row would
    // otherwise INSERT a phantom row holding just this one column (resurrection).
    // The EXISTS guard keeps commit strictly an UPDATE of live rows. (Bulk
    // delete now also purges results, so this is defense-in-depth.)
    const results = db.prepare(`
      SELECT r.row_index, r.output_value FROM ai_results r
      WHERE r.run_id = ? AND r.user_id = ? AND r.status = 'accepted'
        AND EXISTS (
          SELECT 1 FROM rows WHERE rows.sheet_id = ? AND rows.user_id = r.user_id
            AND rows.row_index = r.row_index
        )
      ORDER BY r.row_index ASC
    `).all(id, req.userId!, run.sheet_id) as Array<{ row_index: number; output_value: string }>;

    const updates = results.map(r => ({ rowIndex: r.row_index, columnName: run.column_name, value: r.output_value }));

    db.transaction(() => {
      upsertCellsBatch(run.sheet_id, req.userId!, updates);
      db.prepare("UPDATE sheets SET updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(run.sheet_id, req.userId!);
    })();

    res.json({ message: 'AI results committed to sheet', rowsCommitted: results.length });
  } catch (error) {
    console.error('Commit AI results error:', error);
    res.status(500).json({ error: 'Failed to commit results' });
  }
});

export default router;
