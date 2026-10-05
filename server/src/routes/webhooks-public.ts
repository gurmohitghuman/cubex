import express from 'express';
import { db } from '../lib/db';
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_TOKEN_PATTERN } from '../lib/constants';
import { sha256Hex } from '../lib/webhook-token';
import { takeWebhookToken } from '../lib/webhook-bucket';
import { checkPayloadShape } from '../lib/json-guard';
import {
  appendWebhookDelivery,
  type WebhookSourceRow,
  type WebhookMappingRow,
} from '../lib/webhook-ingest';

// PUBLIC, UNAUTHENTICATED ingestion endpoint: POST /api/webhooks/:token.
// Mounted in index.ts WITHOUT authenticateToken. The token IS the capability.
// This is the highest-risk surface in the app — the pipeline rejects cheaply
// first so a random-token spray dies before any JSON parse or DB write.
//
// NOTE: the global express.json (32MB) is SKIPPED for /api/webhooks/ in
// applyServerMiddleware, so the small-cap parser below actually governs.

const router = express.Router();

// The resolved source is stashed here by validateSource so the handler doesn't
// re-query. Typed locally; not exported.
interface WebhookReq extends express.Request {
  webhookSource?: WebhookSourceRow;
}

// PRE-BODY validation (steps 1, 3, 4 + content-type). Runs BEFORE the body is
// parsed so a random-token spray or a content-type mismatch dies before we ever
// buffer/parse up to 512KB — the cheap rejections must precede parser work, or
// the per-token bucket (the primary limiter) can't protect parser CPU/memory.
function validateSource(req: WebhookReq, res: express.Response, next: express.NextFunction) {
  const { token } = req.params;

  // Step 1: cheap token-format check -> generic 404 (no oracle).
  if (!WEBHOOK_TOKEN_PATTERN.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }

  // JSON-only: reject a wrong/absent content-type with 415 BEFORE parsing, so a
  // 32MB form-urlencoded body can't be buffered against a valid token.
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json.' });
  }

  // Step 3: token_hash lookup -> unknown OR disabled both return generic 404.
  const tokenHash = sha256Hex(token);
  const source = db.prepare(
    `SELECT id, user_id, sheet_id, enabled, raw_column_name, store_raw_mode, total_received
       FROM webhook_sources WHERE token_hash = ?`,
  ).get(tokenHash) as WebhookSourceRow | undefined;
  if (!source || source.enabled !== 1) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Step 4: per-source bucket — keyed on the STABLE source.id (not the token
  // hash) so rotation can't reset the limit, and ONLY now that the token is
  // validated (never key an unknown token → memory-DoS vector).
  const decision = takeWebhookToken(source.id);
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSec));
    return res.status(429).json({ error: 'Rate limit exceeded.' });
  }

  req.webhookSource = source;
  next();
}

// Small-cap JSON parser for THIS path only (runs AFTER validateSource).
const parseJson = express.json({ limit: WEBHOOK_MAX_BODY_BYTES, type: 'application/json' });

// Translate body-parser failures into the right status (413 oversize, 400 bad
// JSON) instead of a bubbled 500.
function parseBody(req: express.Request, res: express.Response, next: express.NextFunction) {
  parseJson(req, res, (err: any) => {
    if (!err) return next();
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ error: 'Payload too large.' });
    }
    return res.status(400).json({ error: 'Invalid JSON.' });
  });
}

// Order: validateSource (regex/ct/lookup/bucket, no body) -> parseBody (512KB)
// -> handler (shape guard + append txn).
router.post('/:token', validateSource, parseBody, (req: WebhookReq, res) => {
  const source = req.webhookSource!;

  // Step 6: structural depth/node guard on the already-parsed body.
  const payload = req.body;
  const shape = checkPayloadShape(payload);
  if (!shape.ok) {
    recordSourceError(source.id, shape.reason || 'Payload rejected');
    return res.status(400).json({ error: shape.reason || 'Payload rejected.' });
  }

  // Re-serialize the parsed body as the canonical stored raw text. (We don't have
  // the original bytes — the parser consumed the stream — but a compact reserialize
  // is faithful for JSON and already within the 512KB cap.)
  const rawPayloadText = JSON.stringify(payload);

  const mappings = db.prepare(
    `SELECT json_path, column_name, value_mode FROM webhook_mappings WHERE source_id = ?`,
  ).all(source.id) as WebhookMappingRow[];

  // Step 7: the append transaction (row cap, insert, delivery, prune, data_version).
  try {
    const result = appendWebhookDelivery(source, mappings, payload, rawPayloadText);
    if (!result.ok) {
      // Row cap reached -> 409 (mirror Clay's "webhook full").
      recordSourceError(source.id, result.reason);
      return res.status(409).json({ error: result.reason });
    }
    return res.status(202).json({ ok: true });
  } catch (err) {
    console.error('Webhook ingest error:', err);
    recordSourceError(source.id, 'Internal error during append');
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Record a redacted failure reason on the source so the drawer can surface it
// (e.g. "sheet full — events being rejected"). Best-effort; never throws.
function recordSourceError(sourceId: string, message: string): void {
  try {
    db.prepare(
      `UPDATE webhook_sources
          SET last_error_at = datetime('now'), last_error_message = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(message.slice(0, 500), sourceId);
  } catch {
    /* best-effort */
  }
}

export default router;
