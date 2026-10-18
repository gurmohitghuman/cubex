// Settings → Trash: how many days deleted rows, sheets and tables are kept
// (0 deletes them at once). Cookie session only (mounted under /api/settings).
// Lowering it empties what is now older at the trash's next sweep, started at once.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { TRASH_DAYS_MAX } from '../lib/constants';
import { getTrashDays, setTrashDays } from '../lib/trash/store';
import { kickTrashPurge } from '../services/trash-purge';

const router = express.Router();
router.use(authenticateToken);

router.get('/trash', (req: AuthRequest, res) => {
  res.json({ days: getTrashDays(req.userId!), maxDays: TRASH_DAYS_MAX });
});

// { days: 0..TRASH_DAYS_MAX }
router.put('/trash', (req: AuthRequest, res) => {
  try {
    const { days } = (req.body ?? {}) as { days?: unknown };
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > TRASH_DAYS_MAX) {
      return res.status(400).json({ error: `Days must be a whole number from 0 to ${TRASH_DAYS_MAX}.` });
    }
    const before = getTrashDays(req.userId!);
    setTrashDays(req.userId!, days);
    if (days < before) kickTrashPurge();
    res.json({ days: getTrashDays(req.userId!), maxDays: TRASH_DAYS_MAX });
  } catch (error) {
    console.error('Set trash days error:', error);
    res.status(500).json({ error: 'Failed to save the setting' });
  }
});

export default router;
