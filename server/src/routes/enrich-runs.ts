// Enrichment run routes (cookie session), next to routes/enrich.ts under
// /api/enrich. Thin: services/enrich-*.ts hold the logic for every surface.
// Pause and cancel are the HTTP run controls (/api/http/jobs/:id/control).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { parseConditions, parseEnrichRunInput, parseRerunInput, parseRows } from '../lib/enrich-run-input';
import { startEnrichmentRun } from '../services/enrich-run-start';
import { enrichRunStatus, resumeEnrichmentRun } from '../services/enrich-run-status';
import { enrichRowCounts } from '../services/enrich-row-count';
import { columnSetup } from '../services/enrich-column';
import { rerunEnrichmentColumn } from '../services/enrich-rerun';
import { reuseCountFor } from '../services/enrich-reuse-count';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { runFailHttpStatus } from '../services/run-shared';
import { parseRuleField } from '../lib/run-condition';
import { checkRunRule } from '../services/run-rule';
import { rerunRowGenerationConflict } from './rerun-row-generation';

const router = express.Router();
router.use(authenticateToken);

const badSheet = (res: express.Response) => res.status(400).json({ error: 'Invalid sheet ID format' });

router.post('/sheets/:id/runs', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return badSheet(res);
    const parsed = parseEnrichRunInput(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    // Selected rows go by row number: a sort elsewhere since they were picked
    // would run (and pay for) other rows. 409 on a row_generation mismatch.
    if (parsed.ok.rows.mode === 'selected') {
      const conflict = rerunRowGenerationConflict(id, req.userId!, req.body);
      if (conflict) return res.status(409).json(conflict);
    }
    const out = await startEnrichmentRun(req.userId!, id, parsed.ok);
    if ('fail' in out) {
      const field = out.field ? { field: out.field } : {};
      return res.status(runFailHttpStatus(out)).json({ error: out.message, ...field });
    }
    res.json(out.ok);
  } catch (error) {
    console.error('Enrichment run start error:', error);
    res.status(500).json({ error: 'Failed to start the enrichment' });
  }
});

// How many rows of the run the drawer would start reuse an earlier found
// answer at $0, for its estimate (the start's body; a pure read).
router.post('/sheets/:id/reuse-count', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return badSheet(res);
    const parsed = parseEnrichRunInput(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    // The drawer drops a count it no longer needs: stop counting then.
    let gone = false;
    res.on('close', () => { gone = !res.writableEnded; });
    const out = await reuseCountFor(req.userId!, id, parsed.ok, () => gone);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Enrichment reuse count error:', error);
    res.status(500).json({ error: "Couldn't count the rows that reuse earlier answers" });
  }
});

// The column menu's reruns of an enrichment column (and, with estimateOnly,
// the confirm's figures: a pure read).
router.post('/sheets/:id/reruns', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return badSheet(res);
    const parsed = parseRerunInput(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (parsed.ok.rows.mode === 'selected' && !parsed.ok.estimateOnly) {
      const conflict = rerunRowGenerationConflict(id, req.userId!, req.body);
      if (conflict) return res.status(409).json(conflict);
    }
    const out = await rerunEnrichmentColumn(req.userId!, id, parsed.ok);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Enrichment rerun error:', error);
    res.status(500).json({ error: 'Failed to run the enrichment' });
  }
});

// Rows by status in a column (not enriched yet, without a result, failed),
// for a scope and the run's "Only run if" (conditions, rule): the drawer's row
// choices, its "the other N rows", and the rows its estimate counts.
router.post('/sheets/:id/row-counts', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return badSheet(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const column = typeof b.column === 'string' && b.column.trim() && b.column.length <= 200 ? b.column : null;
    const rows = parseRows({ mode: b.mode, status: 'any', rowIndexes: b.rowIndexes }, true);
    if (typeof rows === 'string') return res.status(400).json({ error: rows });
    const where = parseConditions(b.conditions);
    if (typeof where === 'string') return res.status(400).json({ error: where });
    const runIf = parseRuleField(b.runIf);
    if ('error' in runIf) return res.status(400).json({ error: runIf.error });
    if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const rule = checkRunRule(id, req.userId!, runIf.ok);
    if ('error' in rule) return res.status(400).json({ error: rule.error });
    const scope = { mode: rows.mode, rowIndexes: rows.rowIndexes, where, rule: rule.ok?.tree ?? null };
    res.json(await enrichRowCounts(id, req.userId!, column, scope));
  } catch (error) {
    console.error('Enrichment row count error:', error);
    res.status(500).json({ error: 'Failed to count the rows' });
  }
});

// "Edit enrichment": the column's tool and choices from its newest run.
router.get('/sheets/:id/column-setup', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return badSheet(res);
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    if (!column.trim() || column.length > 200) return res.status(400).json({ error: 'Pick an enrichment column.' });
    const out = await columnSetup(req.userId!, id, column);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Enrichment column setup error:', error);
    res.status(500).json({ error: 'Failed to read the enrichment' });
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
    const out = await resumeEnrichmentRun(req.params.id, req.userId!, req.body?.spendLimitUsd, req.body?.concurrency);
    if ('fail' in out) {
      const status = out.fail === 'not_found' ? 404 : out.fail === 'conflict' ? 409
        : out.fail === 'spend_cap' ? 403 : 400;
      return res.status(status).json({ error: out.message });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Enrichment run resume error:', error);
    res.status(500).json({ error: 'Failed to resume the run' });
  }
});

export default router;
