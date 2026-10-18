// The app's auto-dedupe setting for a sheet: read it, turn it on or change it,
// turn it off. One implementation with /api/v1 and MCP (services/auto-dedupe-setting.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { runFailHttpStatus } from '../services/run-shared';
import {
  autoDedupeView, setAutoDedupe, turnOffAutoDedupe, type AutoDedupeFail,
} from '../services/auto-dedupe-setting';

const router = express.Router();
router.use(authenticateToken);

// A paused run holding the sheet comes back as blockingRun, so the app offers "Cancel it".
const failJson = (f: AutoDedupeFail) => ({
  error: f.message, ...(f.busy ? { busy: true } : {}), ...(f.blockingRun ? { blockingRun: f.blockingRun } : {}),
});

router.get('/:id/auto-dedupe', (req: AuthRequest, res) => {
  try {
    if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ autoDedupe: autoDedupeView(req.params.id, req.userId!) });
  } catch (error) {
    console.error('Read auto-dedupe error:', error);
    res.status(500).json({ error: 'Failed to read auto-dedupe' });
  }
});

// PUT /:id/auto-dedupe {column, match, phone_country, keep}
router.put('/:id/auto-dedupe', (req: AuthRequest, res) => {
  try {
    const b = req.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'Send a JSON object.' });
    const out = setAutoDedupe(req.userId!, req.params.id,
      { column: b.column, match: b.match, phone_country: b.phone_country, keep: b.keep });
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json(failJson(out));
    res.json({ autoDedupe: out.ok });
  } catch (error) {
    console.error('Set auto-dedupe error:', error);
    res.status(500).json({ error: 'Failed to save auto-dedupe' });
  }
});

router.delete('/:id/auto-dedupe', (req: AuthRequest, res) => {
  try {
    const out = turnOffAutoDedupe(req.userId!, req.params.id);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json(failJson(out));
    res.json({ autoDedupe: null });
  } catch (error) {
    console.error('Turn off auto-dedupe error:', error);
    res.status(500).json({ error: 'Failed to turn off auto-dedupe' });
  }
});

export default router;
