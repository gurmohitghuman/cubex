// The answer panel's routes (cookie session), under /api/enrich next to
// routes/enrich.ts. Thin: services/answer-*.ts hold the logic, for enrichment
// and HTTP API columns alike.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { readAnswer } from '../services/answer-read';
import { addAnswerField } from '../services/answer-field-add';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();
router.use(authenticateToken);

const MAX_NAME = 200;
const MAX_PATH = 1000;
const text = (v: unknown, max: number): string | null =>
  (typeof v === 'string' && v.trim() && v.length <= max ? v : null);
const rowIndex = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

// One cell's stored answer (a pure read).
router.get('/sheets/:id/answer', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
    const column = text(req.query.column, MAX_NAME);
    const row = rowIndex(req.query.row);
    if (!column || row === null) return res.status(400).json({ error: 'column and row are required' });
    const out = readAnswer(req.userId!, id, column, row);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Answer read error:', error);
    res.status(500).json({ error: 'Failed to read the answer' });
  }
});

// "Add as column": a new column filled from the answers already stored (free).
router.post('/sheets/:id/fields', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const column = text(b.column, MAX_NAME), jsonPath = text(b.jsonPath, MAX_PATH), name = text(b.name, MAX_NAME);
    if (!column || !jsonPath || !name) return res.status(400).json({ error: 'column, jsonPath and name are required' });
    const row = b.row === undefined || b.row === null ? null : rowIndex(b.row);
    if (b.row !== undefined && b.row !== null && row === null) {
      return res.status(400).json({ error: 'row is not valid' });
    }
    const out = await addAnswerField(req.userId!, id, { column, jsonPath, name, row });
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Add field error:', error);
    res.status(500).json({ error: 'Failed to add the column' });
  }
});

export default router;
