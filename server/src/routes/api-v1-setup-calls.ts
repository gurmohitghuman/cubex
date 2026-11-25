// /api/v1 setup calls: a saved setup run on items without a sheet, and its results. Thin wrappers over
// services/setup-call.ts, which MCP's call_setup and get_setup_call use too, so the surfaces can't drift. Pause,
// resume and stop: POST /v1/setup-runs/:id/control with the call's id (api-v1-setups.ts).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus } from '../services/run-shared';
import { setRateLimitedHeaders } from '../lib/rate-window';
import { CALL_NOT_FOUND, callSetup, getSetupCall } from '../services/setup-call';
import { callInputOf } from '../services/setup-call-input';

const router = express.Router();

const body = (req: TokenAuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

type Handler = (req: TokenAuthRequest, res: express.Response) => unknown;
const guarded = (route: string, fn: Handler): Handler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${route} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: 'Setup call failed' });
  }
};

// { items, models, estimate_only, webhook_id, max_cost_usd, allow_unpriced }: a price (200), or the call (201).
router.post('/setups/:setupId/calls', requireScope('run'), guarded('POST /v1/setups/:id/calls', async (req, res) => {
  const b = body(req);
  const input = callInputOf(b, 'v1');
  if ('fail' in input) return res.status(runFailHttpStatus(input)).json({ error: input.message });
  const out = await callSetup(req.userId!, req.params.setupId, b.items, input,
    { hasSecretsScope: !!req.tokenScopes?.has('secrets'), tokenId: req.accessTokenId });
  if ('fail' in out) {
    const kind = out.fail;
    if (kind === 'rate_limited') {
      if (out.rate) setRateLimitedHeaders(res, out.rate);
      return res.status(429).json({ error: out.message, retry_after_seconds: out.rate?.retryAfterSec });
    }
    // Over the ceiling: 409 with the estimate it was checked against (over_ceiling: true).
    const over = kind === 'over_ceiling' ? { over_ceiling: true, estimate: out.estimate } : {};
    return res.status(runFailHttpStatus({ fail: kind, message: out.message })).json({ error: out.message, ...over });
  }
  return res.status('setup_call' in out.ok ? 201 : 200).json(out.ok);
}));

router.get('/setup-calls/:callId', requireScope('read'), guarded('GET /v1/setup-calls/:id', (req, res) => {
  const call = getSetupCall(req.userId!, req.params.callId);
  return call ? res.json(call) : res.status(404).json({ error: CALL_NOT_FOUND });
}));

export default router;
