// List results into rows (cookie session), under /api/enrich next to
// routes/enrich-runs.ts. Thin: services/enrich-list-fields.ts and enrich-list-guard.ts hold the logic.
import express from 'express';
import { AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { parseDedupe, parseListFields } from '../lib/enrich-list-input';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { listFieldChoices, pickListFields } from '../services/enrich-list-fields';
import { resultsNotAdded } from '../services/enrich-list-guard';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();

const columnOf = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim() && v.length <= 200 ? v : null);

// The fields a list column's results have (to pick the ones to keep), and the
// results waiting for that pick.
router.get('/sheets/:id/list-fields', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
    const column = columnOf(req.query.column);
    if (!column) return res.status(400).json({ error: 'Pick a column that adds rows.' });
    if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const out = listFieldChoices(req.userId!, id, column);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('List fields read error:', error);
    res.status(500).json({ error: 'Failed to read the results' });
  }
});

// "Add these rows": the fields to keep for results waiting for them.
router.post('/sheets/:id/list-fields', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const column = columnOf(b.column);
    if (!column) return res.status(400).json({ error: 'Pick a column that adds rows.' });
    const fields = parseListFields(b.fields);
    if (typeof fields === 'string') return res.status(400).json({ error: fields });
    if (!fields) return res.status(400).json({ error: 'Keep at least one field.' });
    const dedupePath = parseDedupe(b.dedupePath, fields);
    if (dedupePath === undefined) {
      return res.status(400).json({ error: 'Skip duplicates by one of the fields you keep.' });
    }
    if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const out = pickListFields(req.userId!, id, column, fields, dedupePath);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('List fields pick error:', error);
    res.status(500).json({ error: 'Failed to save the fields' });
  }
});

// Results this sheet bought that aren't rows yet: the delete confirm says
// deleting the sheet drops them.
router.get('/sheets/:id/results-not-added', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
    if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ notAdded: resultsNotAdded(id, req.userId!) });
  } catch (error) {
    console.error('Results not added read error:', error);
    res.status(500).json({ error: 'Failed to read the results' });
  }
});

export default router;
