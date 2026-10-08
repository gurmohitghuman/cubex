// Enrichment run routes (cookie session), next to routes/enrich.ts under
// /api/enrich. Thin: services/enrich-run-*.ts hold the logic for every surface.
// Pause and cancel are the HTTP run controls (/api/http/jobs/:id/control).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { parseEnrichRunInput } from '../lib/enrich-run-input';
import { startEnrichmentRun } from '../services/enrich-run-start';
import { enrichRunStatus, resumeEnrichmentRun } from '../services/enrich-run-status';
import { runFailHttpStatus } from '../services/run-shared';
import { rerunRowGenerationConflict } from './rerun-row-generation';

const router = express.Router();
router.use(authenticateToken);

router.post('/sheets/:id/runs', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
    const parsed = parseEnrichRunInput(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    // Selected rows go by row number: a sort elsewhere since they were picked
    // would run (and pay for) other rows. 409 on a row_generation mismatch.
    if (parsed.ok.rows.mode === 'selected') {
      const conflict = rerunRowGenerationConflict(id, req.userId!, req.body);
      if (conflict) return res.status(409).json(conflict);
    }
    const out = await startEnrichmentRun(req.userId!, id, parsed.ok);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Enrichment run start error:', error);
    res.status(500).json({ error: 'Failed to start the enrichment' });
  }
});

router.get('/runs/:id', (req: AuthRequest, res) => {
  try {
    const status = enrichRunStatus(req.params.id, req.userId!);
    if (!status) return res.status(404).json({ error: 'Enrichment run not found' });
    res.json(status);
  } catch (error) {
    console.error('Enrichment run status error:', error);
    res.status(500).json({ error: 'Failed to read the run' });
  }
});

router.post('/runs/:id/resume', async (req: AuthRequest, res) => {
  try {
    const out = await resumeEnrichmentRun(req.params.id, req.userId!, req.body?.spendLimitUsd);
    if ('fail' in out) return res.status(out.fail === 'not_found' ? 404 : out.fail === 'conflict' ? 409 : 400).json({ error: out.message });
    res.json({ ok: true });
  } catch (error) {
    console.error('Enrichment run resume error:', error);
    res.status(500).json({ error: 'Failed to resume the run' });
  }
});

export default router;
