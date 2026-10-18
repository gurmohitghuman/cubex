// The grid's value counts (reads only):
//   GET /:id/values?column=&view=   a column's most common values (services/value-counts.ts)
// `view` is the view the tab shows: another one active now answers 409 viewChanged.
// A request the tab gave up on (a closed menu) stops between slices.
import express, { type Response } from 'express';
import { authenticateToken, type AuthRequest } from '../middleware/auth';
import { columnValueCounts } from '../services/value-counts';

const router = express.Router();
router.use(authenticateToken);

// Stops a walk once the tab has gone (closed the request).
function watchGone(res: Response): () => boolean {
  let gone = false;
  res.on('close', () => { if (!res.writableFinished) gone = true; });
  return () => gone;
}

type Fail = { fail: 'invalid' | 'not_found' | 'view_changed'; error: string };
function sendFail(res: Response, f: Fail) {
  if (f.fail === 'view_changed') return res.status(409).json({ error: f.error, viewChanged: true });
  return res.status(f.fail === 'not_found' ? 404 : 400).json({ error: f.error });
}

router.get('/:id/values', async (req: AuthRequest, res) => {
  try {
    const out = await columnValueCounts(req.params.id, req.userId!, req.query.column, req.query.view,
      watchGone(res));
    if ('stopped' in out) return res.status(499).end();
    if ('fail' in out) return sendFail(res, out);
    if ('tooMany' in out) return res.json({ tooMany: true, error: out.tooMany });
    if ('busy' in out) return res.json({ busy: true, error: out.busy });
    res.json(out.ok);
  } catch (error) {
    console.error('Value counts error:', error);
    res.status(500).json({ error: 'Counting values failed' });
  }
});

export default router;
