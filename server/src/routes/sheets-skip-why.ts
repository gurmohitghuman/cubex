// Why a "⏭️ Condition not met" cell didn't run, for the grid's panel (cookie session):
// GET /api/sheets/:id/skip-why?row=<row_index>&column=<run column>. services/skip-why.ts checks the column's
// "Only run if" rules against the row as it is now; free, no AI.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { db } from '../lib/db';
import { parseRowData, verifySheetOwnership } from '../lib/sql-helpers';
import { columnSkipRules, skipWhy } from '../services/skip-why';

const router = express.Router();
router.use(authenticateToken);

router.get('/:id/skip-why', (req: AuthRequest, res) => {
  try {
    const sheetId = req.params.id;
    if (!verifySheetOwnership(sheetId, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const row = Number(req.query.row);
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    if (!Number.isSafeInteger(row) || row < 0 || !column) {
      return res.status(400).json({ error: 'row (a row number) and column are required' });
    }
    const data = db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index = ?').pluck()
      .get(sheetId, req.userId!, row) as string | undefined;
    if (data === undefined) return res.status(404).json({ error: 'That row is gone.' });
    const rules = columnSkipRules(sheetId, req.userId!, column);
    res.json({ ...skipWhy(rules, parseRowData(data)), has_rule: rules.length > 0 });
  } catch (error) {
    console.error('Skip why error:', error);
    res.status(500).json({ error: 'Failed to read why the row didn\'t run' });
  }
});

export default router;
