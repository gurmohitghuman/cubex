// /v1 waterfall columns: start or estimate one (waterfall_column's arguments
// as JSON), and read a column's setup. Thin wrappers over the service MCP uses
// (services/waterfall-token-run.ts), so the two surfaces can't drift. A
// started run answers 202 like every run start; an estimate or a replayed
// start answers 200. REST estimates only when asked (estimate_only: true).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { setRateLimitedHeaders } from '../lib/rate-window';
import { runFailHttpStatus } from '../services/run-shared';
import { tokenWaterfall } from '../services/waterfall-token-run';

const router = express.Router();

const callerOf = (req: TokenAuthRequest) =>
  ({ userId: req.userId!, tokenId: req.accessTokenId!, scopes: req.tokenScopes ?? new Set<string>() });

async function answer(res: express.Response, r: Awaited<ReturnType<typeof tokenWaterfall>>) {
  if ('fail' in r) {
    if (r.fail === 'rate_limited') {
      if (r.rate) setRateLimitedHeaders(res, r.rate);
      return res.status(429).json({ error: r.message, retry_after_seconds: r.rate?.retryAfterSec });
    }
    return res.status(runFailHttpStatus({ fail: r.fail, message: r.message })).json({ error: r.message });
  }
  return res.status(r.started ? 202 : 200).json(r.ok);
}

// POST /v1/sheets/:id/waterfall-columns (idempotency_key in the body or the Idempotency-Key header).
router.post('/sheets/:id/waterfall-columns', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.action === 'describe') {
      return res.status(400).json({ error: 'Read a setup with GET .../waterfall-columns/:column.' });
    }
    const r = await tokenWaterfall(callerOf(req), {
      ...b, sheet_id: req.params.id, idempotency_key: b.idempotency_key ?? req.get('Idempotency-Key') ?? undefined,
    }, { estimateDefault: false });
    return answer(res, r);
  } catch (error) {
    console.error('POST /v1/sheets/:id/waterfall-columns error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to start the waterfall' });
  }
});

// GET /v1/sheets/:id/waterfall-columns/:column: the column's setup, as waterfall_column takes it.
router.get('/sheets/:id/waterfall-columns/:column', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const r = await tokenWaterfall(callerOf(req),
      { action: 'describe', sheet_id: req.params.id, column_name: req.params.column }, { estimateDefault: true });
    return answer(res, r);
  } catch (error) {
    console.error('GET /v1/sheets/:id/waterfall-columns/:column error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read the waterfall' });
  }
});

export default router;
