// Run control routes (cookie session), under /api/run-controls: the column
// menu's numbers and runs, the header's "N failed, retry" and a cell's play
// button, for AI, HTTP API, enrichment and waterfall columns alike. Thin: the
// services hold the logic (services/run-controls*.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import { runColumnOf } from '../services/run-controls-column';
import { runColumnCounts, sheetFailedCounts } from '../services/run-controls-counts';
import { estimateRunControl } from '../services/run-controls-estimate';
import { startRunControl } from '../services/run-controls';
import { parseRunControl } from '../services/run-controls-target';
import { rerunRowGenerationConflict } from './rerun-row-generation';

const router = express.Router();
router.use(authenticateToken);

const fail = (res: express.Response, f: RunFail) =>
  res.status(runFailHttpStatus(f)).json({ error: f.message, ...(f.nothingToRun ? { nothingToRun: true } : {}) });
const NOT_A_RUN_COLUMN = 'This column isn\'t filled by an AI, HTTP API, enrichment or waterfall run.';

// One handler shape: a bad or unknown sheet is 400/404, a throw 500. gone():
// the asker left (a count over a million rows stops there).
function handle(
  what: string, fn: (req: AuthRequest, res: express.Response, sheetId: string, gone: () => boolean) => Promise<unknown>,
) {
  return async (req: AuthRequest, res: express.Response) => {
    let left = false;
    res.on('close', () => { left = !res.writableEnded; });
    try {
      const { id } = req.params;
      if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
      if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
      await fn(req, res, id, () => left);
    } catch (error) {
      console.error(`Run controls: ${what} error:`, error);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${what}` });
    }
  };
}

// The column menu's numbers: rows, empty, out of date, failed.
router.get('/sheets/:id/counts', handle('count the rows', async (req, res, id, gone) => {
  const column = typeof req.query.column === 'string' ? req.query.column : '';
  const col = column ? runColumnOf(id, req.userId!, column) : null;
  if (!col) return res.status(400).json({ error: NOT_A_RUN_COLUMN });
  const out = await runColumnCounts(id, req.userId!, col.main, gone);
  if ('stopped' in out) return;
  if ('busy' in out) return res.status(409).json({ error: out.busy, busy: true });
  res.json({ kind: col.kind, column: col.main, ...out.ok });
}));

// The header's "N failed, retry": failed rows per run column (only those with some).
router.get('/sheets/:id/failed', handle('count the failed rows', async (req, res, id, gone) => {
  const out = await sheetFailedCounts(id, req.userId!, gone);
  if ('stopped' in out) return;
  if ('busy' in out) return res.status(409).json({ error: out.busy, busy: true });
  res.json({ columns: out.ok });
}));

// What a run would take and cost (a pure read): { column, rows | row, rowGeneration? }.
router.post('/sheets/:id/estimate', handle('estimate the run', async (req, res, id) => {
  const parsed = parseRunControl(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const col = runColumnOf(id, req.userId!, parsed.ok.column);
  if (!col) return res.status(400).json({ error: NOT_A_RUN_COLUMN });
  const out = await estimateRunControl(req.userId!, id, col, parsed.ok.target, parsed.ok.rowGeneration);
  if ('fail' in out) return fail(res, out);
  res.json(out.ok);
}));

// Start it: { column, rows | row, rowGeneration?, spendLimitUsd? }. One row is
// fenced by the generation the grid had when it was picked (a sort since: 409).
router.post('/sheets/:id/runs', handle('start the run', async (req, res, id) => {
  const parsed = parseRunControl(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const col = runColumnOf(id, req.userId!, parsed.ok.column);
  if (!col) return res.status(400).json({ error: NOT_A_RUN_COLUMN });
  if ('row' in parsed.ok.target) {
    const conflict = rerunRowGenerationConflict(id, req.userId!, req.body);
    if (conflict) return res.status(409).json(conflict);
  }
  const out = await startRunControl(req.userId!, id, col, parsed.ok.target, parsed.ok);
  if ('fail' in out) return fail(res, out);
  res.json(out.ok);
}));

export default router;
