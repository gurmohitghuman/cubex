// Hiring tables over /api/v1 (services/hiring-agent.ts): make one (write),
// read it, check it (run: paid, an estimate unless estimate_only is false).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import { agentCheckHiring, agentCreateHiring, agentGetHiring } from '../services/hiring-agent';

const router = express.Router();
const send = (res: express.Response, out: { ok: unknown } | RunFail, created = false) => ('ok' in out
  ? res.status(created ? 201 : 200).json(out.ok) : res.status(runFailHttpStatus(out)).json({ error: out.message }));

router.post('/hiring', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try { send(res, await agentCreateHiring(req.userId!, req.body), true); } catch (error) {
    console.error('POST /v1/hiring error:', error);
    res.status(500).json({ error: 'Failed to make the hiring table' });
  }
});

router.get('/hiring/:id', requireScope('read'), (req: TokenAuthRequest, res) => {
  try { send(res, agentGetHiring(req.userId!, req.params.id)); } catch (error) {
    console.error('GET /v1/hiring/:id error:', error);
    res.status(500).json({ error: 'Failed to read the hiring table' });
  }
});

// A check is an estimate unless estimate_only is false, as MCP's is.
router.post('/hiring/:id/check', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as { estimate_only?: unknown; time_zone?: unknown };
    send(res, await agentCheckHiring(req.userId!, req.accessTokenId!, req.params.id,
      { estimateOnly: b.estimate_only !== false, timeZone: b.time_zone }));
  } catch (error) {
    console.error('POST /v1/hiring/:id/check error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't check the hiring table" });
  }
});

export default router;
