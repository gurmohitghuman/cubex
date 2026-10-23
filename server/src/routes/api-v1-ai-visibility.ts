// AI visibility tables over /api/v1 (services/ai-visibility-agent.ts): make
// one (write), ask its engines or check it again (run: paid, estimate_only for
// the cost first), change the brands it looks for (write).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import {
  agentAskAiVisibility, agentCheckAiVisibility, agentCreateAiVisibility, agentSetAiVisibilityBrands,
} from '../services/ai-visibility-agent';

const router = express.Router();
const send = (res: express.Response, out: { ok: unknown } | RunFail, created = false) => ('ok' in out
  ? res.status(created ? 201 : 200).json(out.ok) : res.status(runFailHttpStatus(out)).json({ error: out.message }));

router.post('/ai-visibility', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try { send(res, await agentCreateAiVisibility(req.userId!, req.body), true); } catch (error) {
    console.error('POST /v1/ai-visibility error:', error);
    res.status(500).json({ error: 'Failed to make the AI visibility table' });
  }
});

router.post('/ai-visibility/:id/ask', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as { again?: unknown; estimate_only?: unknown };
    send(res, await agentAskAiVisibility(req.userId!, req.accessTokenId!, req.params.id,
      { again: b.again === true, estimateOnly: b.estimate_only === true }));
  } catch (error) {
    console.error('POST /v1/ai-visibility/:id/ask error:', error);
    res.status(500).json({ error: "Couldn't ask the engines" });
  }
});

// A check is an estimate unless estimate_only is false, as MCP's is.
router.post('/ai-visibility/:id/check-again', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as { estimate_only?: unknown; time_zone?: unknown; fresh?: unknown };
    send(res, await agentCheckAiVisibility(req.userId!, req.accessTokenId!, req.params.id,
      { estimateOnly: b.estimate_only !== false, timeZone: b.time_zone, fresh: b.fresh === true }));
  } catch (error) {
    console.error('POST /v1/ai-visibility/:id/check-again error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't check the table again" });
  }
});

router.put('/ai-visibility/:id/brands', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try { send(res, await agentSetAiVisibilityBrands(req.userId!, req.params.id, req.body)); } catch (error) {
    console.error('PUT /v1/ai-visibility/:id/brands error:', error);
    res.status(500).json({ error: "Couldn't save the brands" });
  }
});

export default router;
