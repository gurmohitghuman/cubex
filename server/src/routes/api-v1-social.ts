// Social research tables over /api/v1 (services/social-agent.ts): make one
// (write), read it, find posts (run: paid, an estimate unless estimate_only is
// false; then it needs max_cost_usd, and over it answers 409 with the estimate now).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import { agentCreateSocial, agentFindPosts, agentGetSocial, type AgentFindFail } from '../services/social-agent';

const router = express.Router();
const send = (res: express.Response, out: { ok: unknown } | RunFail | AgentFindFail, created = false) => ('ok' in out
  ? res.status(created ? 201 : 200).json(out.ok)
  : res.status(runFailHttpStatus(out)).json({ error: out.message,
    ...('estimate' in out && out.estimate ? { over_ceiling: true, estimate: out.estimate } : {}) }));

router.post('/social-research', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try { send(res, await agentCreateSocial(req.userId!, req.body), true); } catch (error) {
    console.error('POST /v1/social-research error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to make the social research table' });
  }
});

router.get('/social-research/:id', requireScope('read'), (req: TokenAuthRequest, res) => {
  try { send(res, agentGetSocial(req.userId!, req.params.id)); } catch (error) {
    console.error('GET /v1/social-research/:id error:', error);
    res.status(500).json({ error: 'Failed to read the social research table' });
  }
});

// Find posts is an estimate unless estimate_only is false, as MCP's is.
router.post('/social-research/:id/find-posts', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as { estimate_only?: unknown; time_zone?: unknown; max_cost_usd?: unknown };
    send(res, await agentFindPosts(req.userId!, req.accessTokenId!, req.params.id,
      { estimateOnly: b.estimate_only, timeZone: b.time_zone, maxCostUsd: b.max_cost_usd }));
  } catch (error) {
    console.error('POST /v1/social-research/:id/find-posts error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't find posts" });
  }
});

export default router;
