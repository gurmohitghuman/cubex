// Saving a setup from a sheet (the app's Save as setup dialog): GET
// /:id/setup-steps lists the sheet's filled columns and what each reads, POST
// /:id/setups/plan shows what a setup of the chosen columns would hold, POST
// /:id/setups saves it. All three only read the sheet, so they're allowed
// while it's busy (sheets.ts). One implementation with /api/v1 and MCP
// (services/setup-save.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus } from '../services/run-shared';
import { planSetup, saveSetup, sheetSteps } from '../services/setup-save';
import { specSummary } from '../services/setup-library';

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

export default router;
