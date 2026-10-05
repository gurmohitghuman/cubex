import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { renameSheetColumn } from '../services/column-rename';

// PUT /:id/columns/:columnName — rename. The cascade implementation (rows.data
// key, column_order, filters, HTTP/webhook refs, run guards) is
// shared with /api/v1 in services/column-rename.ts.
const router = express.Router();
router.use(authenticateToken);

router.put('/:id/columns/:columnName', async (req: AuthRequest, res) => {
  try {
    const { id, columnName } = req.params;
    const { newName } = req.body as { newName?: unknown };

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });
    if (typeof newName !== 'string' || !newName.trim()) {
      return res.status(400).json({ error: 'New column name is required' });
    }

    const result = await renameSheetColumn(id, req.userId!, columnName, newName);
    if ('fail' in result) {
      switch (result.fail) {
        case 'column_not_found':
          return res.status(404).json({ error: `Column "${columnName}" not found in this sheet` });
        case 'active_run':
        case 'busy':
          return res.status(409).json({ error: result.error });
        default: // 'invalid' | 'collision' — historical UI status is 400 for both
          return res.status(400).json({ error: result.error });
      }
    }
    res.json({ message: 'Column renamed successfully' });
  } catch (error) {
    console.error('Rename column error:', error);
    res.status(500).json({ error: 'Failed to rename column' });
  }
});

export default router;
