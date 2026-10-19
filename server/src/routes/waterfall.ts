// Waterfall column routes (cookie session), under /api/waterfall. Thin: the
// services hold the logic for every surface (the app, /api/v1 and MCP). Pause
// and cancel are the HTTP run controls (/api/http/jobs/:id/control), a resume
// with a higher limit is here; tools are searched with the enrichment routes
// (/api/enrich/tools).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { parseWaterfallInput } from '../lib/waterfall/input';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import { startWaterfallRun } from '../services/waterfall-run-start';
import { estimateWaterfall } from '../services/waterfall-estimate';
import { waterfallSetup } from '../services/waterfall-column';
import { parseWaterfallRerun, rerunWaterfallColumn } from '../services/waterfall-rerun';
import { readWaterfallTrace } from '../services/waterfall-trace';
import { waterfallRunStatus } from '../services/waterfall-status';
import { resumeWaterfallRun } from '../services/waterfall-agent-control';
import { startWaterfallDryRun } from '../services/waterfall-dry-run';
import { readDryRun } from '../services/waterfall-dry-read';
import { rerunRowGenerationConflict } from './rerun-row-generation';
import { WATERFALL_TEMPLATES } from '../lib/waterfall/templates';

const router = express.Router();
router.use(authenticateToken);

const fail = (res: express.Response, f: RunFail) =>
  res.status(runFailHttpStatus(f)).json({ error: f.message, ...(f.nothingToRun ? { nothingToRun: true } : {}) });

// One handler shape: a bad sheet id is 400, a parse error 400, a throw 500.
function handle(what: string, fn: (req: AuthRequest, res: express.Response, sheetId: string) => Promise<unknown>) {
  return async (req: AuthRequest, res: express.Response) => {
    try {
      const { id } = req.params;
      if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
      await fn(req, res, id);
    } catch (error) {
      console.error(`Waterfall ${what} error:`, error);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${what}` });
    }
  };
}

// The starter waterfalls for the drawer's first screen (fixed, so it answers at once).
router.get('/templates', (_req: AuthRequest, res) => {
  res.json(WATERFALL_TEMPLATES);
});

router.post('/sheets/:id/estimate', handle('estimate the waterfall', async (req, res, id) => {
  const parsed = parseWaterfallInput(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const out = await estimateWaterfall(req.userId!, id, parsed.ok);
  if ('fail' in out) return fail(res, out);
  res.json(out.ok);
}));

router.post('/sheets/:id/runs', handle('start the waterfall', async (req, res, id) => {
  const parsed = parseWaterfallInput(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  if (parsed.ok.dry) return res.status(400).json({ error: 'Start a dry run from its own button.' });
  if (parsed.ok.rows.mode === 'selected') {
    const conflict = rerunRowGenerationConflict(id, req.userId!, req.body);
    if (conflict) return res.status(409).json(conflict);
  }
  const out = await startWaterfallRun(req.userId!, id, parsed.ok, { hasSecretsScope: true });
  if ('fail' in out) return fail(res, out);
  res.json(out.ok);
}));

// A dry run (the drawer's "Try on 3 rows" and a step's Test): writes nothing to the sheet.
router.post('/sheets/:id/dry-runs', handle('start the dry run', async (req, res, id) => {
  const parsed = parseWaterfallInput(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  if (!parsed.ok.dry) return res.status(400).json({ error: 'dry is required.' });
  const out = await startWaterfallDryRun(req.userId!, id, parsed.ok, { hasSecretsScope: true });
  if ('fail' in out) return fail(res, out);
  res.status(202).json(out.ok);
}));

router.get('/sheets/:id/column-setup', handle('read the waterfall', async (req, res, id) => {
  const column = typeof req.query.column === 'string' ? req.query.column : '';
  if (!column) return res.status(400).json({ error: 'column is required.' });
  const out = waterfallSetup(id, req.userId!, column);
  if ('fail' in out) return fail(res, out);
  res.json(out.ok);
}));

// The column menu's reruns (and, with estimateOnly, the confirm's figures: a pure read).
router.post('/sheets/:id/reruns', handle('run the waterfall again', async (req, res, id) => {
  const parsed = parseWaterfallRerun(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  if (parsed.ok.rowIndexes && !parsed.ok.estimateOnly) {
    const conflict = rerunRowGenerationConflict(id, req.userId!, req.body);
    if (conflict) return res.status(409).json(conflict);
  }
  const out = await rerunWaterfallColumn(req.userId!, id, parsed.ok,
    { estimateOnly: parsed.ok.estimateOnly, hasSecretsScope: true });
  if ('fail' in out) return fail(res, out);
  res.json(out.ok);
}));

router.get('/sheets/:id/trace', handle('read the trace', async (req, res, id) => {
  const column = typeof req.query.column === 'string' ? req.query.column : '';
  const row = Number(req.query.row);
  if (!column || !Number.isInteger(row) || row < 0) {
    return res.status(400).json({ error: 'column and row are required.' });
  }
  const out = readWaterfallTrace(req.userId!, id, column, row);
  if ('fail' in out) return fail(res, out);
  res.json(out.ok);
}));

// A dry run's progress and each of its rows' trace (the drawer polls it while open).
router.get('/dry-runs/:runId', (req: AuthRequest, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_PATTERN.test(runId)) return res.status(400).json({ error: 'Invalid run ID format' });
    const view = readDryRun(req.userId!, runId);
    if (!view) return res.status(404).json({ error: 'Dry run not found' });
    res.json(view);
  } catch (error) {
    console.error('Waterfall dry run read error:', error);
    res.status(500).json({ error: 'Failed to read the dry run' });
  }
});

// A run's progress, spend and per-step counts (the drawer polls it while open).
router.get('/runs/:runId', async (req: AuthRequest, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_PATTERN.test(runId)) return res.status(400).json({ error: 'Invalid run ID format' });
    const status = waterfallRunStatus(req.userId!, runId);
    if (!status) return res.status(404).json({ error: 'Run not found' });
    res.json(status);
  } catch (error) {
    console.error('Waterfall run status error:', error);
    res.status(500).json({ error: 'Failed to read the run' });
  }
});

// Resume a paused run, with a higher run limit when one is given (a run that
// stopped at its limit would pause again at once). The REST and MCP resume
// call the same service.
router.post('/runs/:runId/resume', async (req: AuthRequest, res) => {
  try {
    const { runId } = req.params;
    if (!UUID_PATTERN.test(runId)) return res.status(400).json({ error: 'Invalid run ID format' });
    const limit = (req.body as { spendLimitUsd?: unknown } | undefined)?.spendLimitUsd;
    if (limit !== undefined && limit !== null && typeof limit !== 'number') {
      return res.status(400).json({ error: 'spendLimitUsd must be a number.' });
    }
    const out = await resumeWaterfallRun(runId, req.userId!, limit as number | null | undefined, true);
    if ('fail' in out) {
      const code = out.fail === 'not_found' ? 404 : out.fail === 'bad_request' ? 400
        : out.fail === 'spend_cap' ? 403 : 409;
      return res.status(code).json({ error: out.message });
    }
    res.json(waterfallRunStatus(req.userId!, runId));
  } catch (error) {
    console.error('Waterfall resume error:', error);
    res.status(500).json({ error: 'Failed to resume the run' });
  }
});

export default router;
