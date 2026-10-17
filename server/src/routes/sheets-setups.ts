// Saving a setup from a sheet (the app's Save as setup dialog): GET
// /:id/setup-steps lists the sheet's filled columns and what each reads, POST
// /:id/setups/plan shows what a setup of the chosen columns would hold, POST
// /:id/setups saves it: these only read the sheet, so they're allowed while
// it's busy (sheets.ts). POST /:id/setups/:setupId/apply prices or starts using
// a setup here; GET /:id/setup-runs lists the ones working on it. One
// implementation with /api/v1 and MCP (services/setup-save.ts, setup-apply.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus } from '../services/run-shared';
import { planSetup, saveSetup, sheetSteps } from '../services/setup-save';
import { specSummary } from '../services/setup-library';
import { applySetup } from '../services/setup-apply';
import { applyInputOf } from '../services/setup-apply-input';
import { sheetSetupRuns } from '../services/setup-run-store';

const router = express.Router();
router.use(authenticateToken);

const body = (req: AuthRequest) =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

router.get('/:id/setup-steps', (req: AuthRequest, res) => {
  try {
    const out = sheetSteps(req.userId!, req.params.id);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json({ steps: out.ok });
  } catch (error) {
    console.error('Setup steps error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read the sheet\'s columns' });
  }
});

router.post('/:id/setups/plan', (req: AuthRequest, res) => {
  try {
    const b = body(req);
    const out = planSetup(req.userId!, req.params.id, b.columns, b.includeUpstream !== false);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json({ ...specSummary(out.ok), spec: out.ok });
  } catch (error) {
    console.error('Setup plan error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to plan the setup' });
  }
});

router.post('/:id/setups', (req: AuthRequest, res) => {
  try {
    const b = body(req);
    const out = saveSetup(req.userId!, req.params.id, {
      name: b.name, description: b.description, columns: b.columns, includeUpstream: b.includeUpstream,
    });
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.status(201).json(out.ok);
  } catch (error) {
    console.error('Save setup error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save the setup' });
  }
});

// { inputs, names, models, firstRows, estimateOnly }: a price for using the
// setup here (with the steps that carry a column of the sheet on), or its
// start (201). A missing input or a name taken answers with `missing` or
// `taken`, so the dialog can point at it.
router.post('/:id/setups/:setupId/apply', async (req: AuthRequest, res) => {
  try {
    const input = applyInputOf(body(req), 'app');
    if ('fail' in input) return res.status(400).json({ error: input.message });
    const out = await applySetup(req.userId!, req.params.id, req.params.setupId, input, { hasSecretsScope: true });
    if ('fail' in out) {
      return res.status(runFailHttpStatus(out)).json({ error: out.message, missing: out.missing, taken: out.taken });
    }
    res.status('setup_run' in out.ok ? 201 : 200).json(out.ok);
  } catch (error) {
    console.error('Apply setup error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to use the setup' });
  }
});

// ?setupId=: that setup's runs here only (the Use a setup dialog's last choices).
router.get('/:id/setup-runs', (req: AuthRequest, res) => {
  try {
    const setupId = typeof req.query.setupId === 'string' && req.query.setupId ? req.query.setupId : undefined;
    res.json({ setup_runs: sheetSetupRuns(req.userId!, req.params.id, 5, setupId) });
  } catch (error) {
    console.error('Setup runs error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read the setups working on this sheet' });
  }
});

export default router;
