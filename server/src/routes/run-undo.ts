// Undoing a run (cookie session), under /api/run-undo: the column menu's
// "Undo last run" for AI, HTTP API, enrichment and waterfall columns, and its
// progress. Thin: the services hold the logic (services/run-undo*.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { runFailHttpStatus } from '../services/run-shared';
import { undoRun } from '../services/run-undo';
import { lastUndoable, runOf, undoViewOf, type UndoRunKind } from '../services/run-undo-view';

const router = express.Router();
router.use(authenticateToken);

const kindOf = (v: unknown): UndoRunKind | null => (v === 'ai' || v === 'http' ? v : null);

// A bad or unknown sheet is 400/404, a throw 500.
function handle(what: string, fn: (req: AuthRequest, res: express.Response, sheetId: string) => Promise<unknown>) {
  return async (req: AuthRequest, res: express.Response) => {
    try {
      const { id } = req.params;
      if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
      if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
      await fn(req, res, id);
    } catch (error) {
      console.error(`Run undo: ${what} error:`, error);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${what}` });
    }
  };
}

// The column's newest run that can still be undone (null: none).
router.get('/sheets/:id/last', handle('find the last run', async (req, res, id) => {
  const column = typeof req.query.column === 'string' ? req.query.column : '';
  res.json({ undo: column ? lastUndoable(req.userId!, id, column) : null });
}));

// One run's undo: what it would do, or how far it got.
router.get('/sheets/:id/runs/:kind/:runId', handle('read the undo', async (req, res, id) => {
  const kind = kindOf(req.params.kind);
  const view = kind && UUID_PATTERN.test(req.params.runId) ? undoViewOf(req.userId!, kind, req.params.runId) : null;
  if (!view || view.sheet_id !== id) return res.status(404).json({ error: 'Run not found' });
  res.json({ undo: view });
}));

// Undo it: { runType: 'ai' | 'http', runId }.
router.post('/sheets/:id/undo', handle('undo the run', async (req, res, id) => {
  const kind = kindOf(req.body?.runType);
  const runId = typeof req.body?.runId === 'string' ? req.body.runId : '';
  if (!kind || !UUID_PATTERN.test(runId)) {
    return res.status(400).json({ error: 'Pass runType (ai or http) and runId.' });
  }
  if (runOf(kind, runId, req.userId!)?.sheet_id !== id) return res.status(404).json({ error: 'Run not found' });
  const out = await undoRun(req.userId!, kind, runId);
  if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
  res.json({ undo: out.ok });
}));

export default router;
