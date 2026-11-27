// Open roles at the companies on a sheet, in the app (services/open-roles.ts). GET /api/open-roles/:sheetId: what
// its search was last run with. POST with the website column, the roles and the filters: estimateOnly true answers
// the estimate, else the run starts with maxCostUsd (the estimate's highUsd; over it, 409 with the estimate now).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { checkMostOf } from '../lib/hiring/input';
import { parseOpenRoles } from '../lib/hiring/open-roles-input';
import { timeZoneOf } from '../lib/ai-visibility/check';
import { openRoles, openRolesSetup } from '../services/open-roles';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();
router.use(authenticateToken);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// What the sheet's search was last run with (setup null: never run here), to show it again.
router.get('/:sheetId', (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.sheetId)) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ setup: openRolesSetup(req.userId!, req.params.sheetId) });
  } catch (error) {
    console.error('Open roles setup error:', error);
    res.status(500).json({ error: "Couldn't read the sheet's open roles search" });
  }
});

router.post('/:sheetId', async (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.sheetId)) return res.status(404).json({ error: 'Sheet not found' });
    const b = isObj(req.body) ? req.body : {};
    const o = parseOpenRoles(b);
    if (typeof o === 'string') return res.status(400).json({ error: o });
    // The asker's time zone, for the run's day (UTC when it isn't one).
    const timeZone = timeZoneOf(b.timeZone);
    const estimateOnly = b.estimateOnly === true;
    let maxCostUsd: number | null = null;
    if (!estimateOnly) {
      const most = checkMostOf(b.maxCostUsd, 'maxCostUsd');
      if ('error' in most) return res.status(400).json({ error: most.error });
      maxCostUsd = most.value;
    }
    const out = await openRoles(req.userId!, req.params.sheetId, { ...o, estimateOnly, maxCostUsd, timeZone });
    if ('fail' in out) {
      return res.status(runFailHttpStatus(out)).json({ error: out.message,
        ...(out.estimate ? { over_ceiling: true, estimate: out.estimate } : {}) });
    }
    res.json(out.ok);
  } catch (error) {
    console.error('Open roles error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't look for open roles" });
  }
});

export default router;
