// Open roles at the companies on a sheet over /api/v1 (services/open-roles-agent.ts): POST
// /v1/sheets/:id/open-roles (run: paid, an estimate unless estimate_only is false; the run needs max_cost_usd, and
// over it answers 409 with the estimate now).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus } from '../services/run-shared';
import { agentOpenRoles } from '../services/open-roles-agent';

const router = express.Router();

router.post('/sheets/:id/open-roles', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const out = await agentOpenRoles(req.userId!, req.accessTokenId!, req.params.id, req.body);
    if ('ok' in out) return res.json(out.ok);
    res.status(runFailHttpStatus(out)).json({ error: out.message,
      ...(out.estimate ? { over_ceiling: true, estimate: out.estimate } : {}) });
  } catch (error) {
    console.error('POST /v1/sheets/:id/open-roles error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't look for open roles" });
  }
});

export default router;
