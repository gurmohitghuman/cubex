// The sheet's Usage view (cookie session): GET /api/sheets/:id/usage for the
// view, /usage/csv for its download. Query: group_by (column, day, run),
// range (this_week, this_month, last_week, last_month) or from and to (days),
// limit. services/usage.ts reads it for every surface.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { readUsage, usageAsk } from '../services/usage';
import { writeUsageCsv } from '../services/usage-csv';

const router = express.Router();
router.use(authenticateToken);

function ask(req: AuthRequest, res: express.Response) {
  if (!UUID_PATTERN.test(req.params.id)) { res.status(400).json({ error: 'Invalid sheet ID format' }); return null; }
  const out = usageAsk(req.userId!, req.params.id, req.query as Record<string, unknown>);
  if ('fail' in out) { res.status(out.fail === 'not_found' ? 404 : 400).json({ error: out.message }); return null; }
  return out.ok;
}

router.get('/:id/usage', (req: AuthRequest, res) => {
  try {
    const a = ask(req, res);
    if (a) res.json(readUsage(a.scope, a.query));
  } catch (error) {
    console.error('Usage read error:', error);
    res.status(500).json({ error: 'Failed to read the usage' });
  }
});

router.get('/:id/usage/csv', async (req: AuthRequest, res) => {
  try {
    const a = ask(req, res);
    if (a) await writeUsageCsv(res, a.scope, a.query.groupBy, a.name);
  } catch (error) {
    console.error('Usage CSV error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download the usage' });
    else res.destroy();
  }
});

export default router;
