import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { describeColumn, describeSheet, type DescribeOutcome } from '../services/descriptions';

// Descriptions from the app: the sheet's (its tab menu) and a column's (the
// column menu). The rules live in services/descriptions.ts, shared with REST
// and MCP. The column goes in the body: a name can hold any character.
const router = express.Router();
router.use(authenticateToken);

function answer(res: express.Response, outcome: DescribeOutcome) {
  if ('ok' in outcome) return res.json(outcome.ok);
  return res.status(outcome.fail === 'not_found' ? 404 : 400).json({ error: outcome.message });
}

router.put('/:id/description', (req: AuthRequest, res) => {
  try {
    answer(res, describeSheet(req.params.id, req.userId!, req.body?.description));
  } catch (error) {
    console.error('Sheet description error:', error);
    res.status(500).json({ error: 'Failed to save the description' });
  }
});

router.put('/:id/column-description', (req: AuthRequest, res) => {
  try {
    const column = req.body?.column;
    if (typeof column !== 'string' || !column) return res.status(400).json({ error: 'column is required' });
    answer(res, describeColumn(req.params.id, req.userId!, column, req.body?.description));
  } catch (error) {
    console.error('Column description error:', error);
    res.status(500).json({ error: 'Failed to save the description' });
  }
});

export default router;
