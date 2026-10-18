// /v1 run undo: GET /{ai,http}-runs/:id/undo says what undoing the run would
// do (or how far an undo got), POST undoes it, over the same services as the
// app's column menu and MCP undo_run (services/run-undo*.ts). An enrichment's
// or a waterfall's run is an HTTP run. GET /sheets/:id/undo?column= finds a
// column's newest run that can still be undone. Undo writes cells: 'write'.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { runFailHttpStatus } from '../services/run-shared';
import { undoRun } from '../services/run-undo';
import { lastUndoable, undoViewOf, type UndoRunKind } from '../services/run-undo-view';

const router = express.Router();

for (const [prefix, kind] of [['ai-runs', 'ai'], ['http-runs', 'http']] as Array<[string, UndoRunKind]>) {
  router.get(`/${prefix}/:id/undo`, requireScope('read'), (req: TokenAuthRequest, res) => {
    try {
      const view = undoViewOf(req.userId!, kind, req.params.id);
      if (!view) return res.status(404).json({ error: 'Run not found' });
      res.json(view);
    } catch (error) {
      console.error(`GET /v1/${prefix}/:id/undo error:`, error);
      res.status(500).json({ error: 'Failed to read the undo' });
    }
  });

  // 200 once it is undone; 202 while a big one goes on (GET it for the counts).
  router.post(`/${prefix}/:id/undo`, requireScope('write'), async (req: TokenAuthRequest, res) => {
    try {
      const out = await undoRun(req.userId!, kind, req.params.id);
      if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
      res.status(out.ok.state === 'undoing' ? 202 : 200).json(out.ok);
    } catch (error) {
      console.error(`POST /v1/${prefix}/:id/undo error:`, error);
      res.status(500).json({ error: 'Failed to undo the run' });
    }
  });
}

router.get('/sheets/:id/undo', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    if (!column) return res.status(400).json({ error: 'Pass column: the run column whose last run to find.' });
    res.json({ undo: lastUndoable(req.userId!, req.params.id, column) });
  } catch (error) {
    console.error('GET /v1/sheets/:id/undo error:', error);
    res.status(500).json({ error: 'Failed to find the last run' });
  }
});

export default router;
