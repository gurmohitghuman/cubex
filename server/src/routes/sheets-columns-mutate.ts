import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { addSheetColumn } from '../services/column-add';

// POST /:id/columns — add a new column with empty values on every existing
// row. Implementation shared with /api/v1 and the MCP add_column tool in
// services/column-add.ts; this wrapper keeps the historical UI status codes
// (400 for validation, collision, AND cap).
const router = express.Router();
router.use(authenticateToken);

router.post('/:id/columns', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { columnName } = req.body as { columnName?: string };
    if (!columnName || typeof columnName !== 'string') {
      return res.status(400).json({ error: 'Column name is required' });
    }
    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    const result = addSheetColumn(id, req.userId!, columnName);
    if ('fail' in result) return res.status(400).json({ error: result.error });

    res.json({ message: 'Column added successfully', columnName: result.name });
  } catch (error) {
    console.error('Add column error:', error);
    res.status(500).json({ error: 'Failed to add column' });
  }
});

export default router;
