// Settings → Enrichment: how many days a found answer is reused before a row
// calls treg again (services/enrich-reuse.ts). Cookie session only (mounted
// under /api/settings), like the daily limit; a run asks for fresh answers with
// "Always call again" (fresh) instead.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { ENRICH_REUSE_DAYS_MAX } from '../lib/constants';
import { getReuseDays, setReuseDays } from '../services/enrich-reuse';

const router = express.Router();
router.use(authenticateToken);

router.get('/enrich-reuse', (req: AuthRequest, res) => {
  res.json({ days: getReuseDays(req.userId!), maxDays: ENRICH_REUSE_DAYS_MAX });
});

// { days: 0..365 }; 0 turns reuse off.
router.put('/enrich-reuse', (req: AuthRequest, res) => {
  try {
    const { days } = (req.body ?? {}) as { days?: unknown };
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > ENRICH_REUSE_DAYS_MAX) {
      return res.status(400).json({ error: `Days must be a whole number from 0 to ${ENRICH_REUSE_DAYS_MAX}.` });
    }
    setReuseDays(req.userId!, days);
    res.json({ days: getReuseDays(req.userId!), maxDays: ENRICH_REUSE_DAYS_MAX });
  } catch (error) {
    console.error('Set answer reuse days error:', error);
    res.status(500).json({ error: 'Failed to save the setting' });
  }
});

export default router;
