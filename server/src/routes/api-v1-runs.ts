// /v1 run starts: POST /sheets/:id/ai-runs and /sheets/:id/http-runs. Thin
// wrappers over services/run-start-token*.ts, the same implementation the MCP
// tools use: estimate_only, preview_rows, structured output_columns,
// idempotency keys (body field or Idempotency-Key header) and the per-token
// run-start window all behave as on MCP. 'run' scope required. A started run
// answers 202 (pollable at GET /v1/{ai,http}-runs/:id, processing is async);
// an estimate, a preview or a replayed start answers 200.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { tokenStartAiRun, type TokenCaller, type TokenRunResult } from '../services/run-start-token';
import { tokenStartHttpRun } from '../services/run-start-token-http';
import { runFailHttpStatus } from '../services/run-shared';
import { setRateLimitedHeaders } from '../lib/rate-window';

const router = express.Router();

const caller = (req: TokenAuthRequest): TokenCaller =>
  ({ userId: req.userId!, tokenId: req.accessTokenId!, scopes: req.tokenScopes ?? new Set() });

// The key may come in the body or as the conventional Idempotency-Key header.
const idempotencyKey = (req: express.Request, b: Record<string, unknown>) =>
  b.idempotency_key ?? req.get('Idempotency-Key') ?? undefined;

function send(res: express.Response, r: TokenRunResult) {
  if ('fail' in r) {
    if (r.fail === 'rate_limited') {
      if (r.rate) setRateLimitedHeaders(res, r.rate);
      return res.status(429).json({ error: r.message, retry_after_seconds: r.rate?.retryAfterSec });
    }
    return res.status(runFailHttpStatus({ fail: r.fail, message: r.message })).json({ error: r.message });
  }
  res.status(r.started ? 202 : 200).json(r.ok);
}

// POST /v1/sheets/:id/ai-runs
// Body: { column_name, prompt, output_columns?, model?, system_prompt?,
//         temperature?, web_search?, search_engine?, search_mode?,
//         max_searches_per_row?, web_fetch?, max_chars?, concurrency?,
//         target_row_ids?, estimate_only?, preview_rows?, idempotency_key? }
router.post('/sheets/:id/ai-runs', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    send(res, await tokenStartAiRun(caller(req), {
      ...b, sheet_id: req.params.id, idempotency_key: idempotencyKey(req, b),
    }));
  } catch (error) {
    console.error('POST /v1/sheets/:id/ai-runs error:', error);
    res.status(500).json({ error: 'Failed to start AI run' });
  }
});

// POST /v1/sheets/:id/http-runs
// Body: { url, method?, headers?, body?, response_mapping: [{ json_path,
//         column_name }], master_column_name?, batch_size?, timeout_ms?,
//         target_row_ids?, estimate_only?, idempotency_key? } (the MCP tool's
//         fields), or the earlier shape { config: { requestConfig (timeout = ms),
//         responseMapping: [{ jsonPath, columnName }], batchSize }, ... }.
router.post('/sheets/:id/http-runs', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cfg = b.config && typeof b.config === 'object' ? b.config as Record<string, any> : null;
    const rc = cfg?.requestConfig && typeof cfg.requestConfig === 'object' ? cfg.requestConfig : null;
    const args = cfg ? {
      url: rc?.url, method: rc?.method, headers: rc?.headers, body: rc?.body,
      response_mapping: Array.isArray(cfg.responseMapping)
        ? cfg.responseMapping.map((m: any) => ({ json_path: m?.jsonPath, column_name: m?.columnName }))
        : cfg.responseMapping,
      batch_size: cfg.batchSize, timeout_ms: rc?.timeout,
    } : {
      url: b.url, method: b.method, headers: b.headers, body: b.body, response_mapping: b.response_mapping,
      batch_size: b.batch_size, timeout_ms: b.timeout_ms,
    };
    send(res, await tokenStartHttpRun(caller(req), {
      ...args, sheet_id: req.params.id, master_column_name: b.master_column_name,
      target_row_ids: b.target_row_ids, estimate_only: b.estimate_only, idempotency_key: idempotencyKey(req, b),
    }));
  } catch (error) {
    console.error('POST /v1/sheets/:id/http-runs error:', error);
    res.status(500).json({ error: 'Failed to start HTTP run' });
  }
});

export default router;
