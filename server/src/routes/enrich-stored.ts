// Settings' "Stored answers" (cookie session), under /api/enrich: their size
// from the last background count, and the prune of old answers' details.
// Thin: services/answer-store-size.ts and answer-prune-age.ts hold the logic.
import express from 'express';
import { AuthRequest } from '../middleware/auth';
import { STORED_ANSWERS_PRUNE_DAYS } from '../lib/constants';
import { storedAnswersView } from '../services/answer-store-size';
import { startAgePrune } from '../services/answer-prune-age';

const router = express.Router();

// Starts a count in the background when the last one is over an hour old.
router.get('/stored-answers', (req: AuthRequest, res) => {
  try {
    res.json(storedAnswersView(req.userId!));
  } catch (error) {
    console.error('Stored answers read error:', error);
    res.status(500).json({ error: 'Failed to read the stored answers' });
  }
});

// Removes the provider's raw data from answers of runs that ended over 90
// days ago; their result fields stay. One prune at a time (409).
router.post('/stored-answers/prune', (req: AuthRequest, res) => {
  try {
    const out = startAgePrune(req.userId!, STORED_ANSWERS_PRUNE_DAYS);
    if ('fail' in out) return res.status(409).json({ error: out.message });
    res.status(202).json({ ...storedAnswersView(req.userId!), jobId: out.ok.jobId });
  } catch (error) {
    console.error('Stored answers prune error:', error);
    res.status(500).json({ error: 'Failed to start pruning old answers' });
  }
});

export default router;
