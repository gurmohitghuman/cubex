import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { getSourceForSheet } from '../lib/webhook-service';

// Authenticated raw-delivery access for a sheet's webhook. Mounted under
// /api/sheets. The raw payload lives in webhook_deliveries (NOT in rows.data);
// these endpoints fetch it on demand for the sample picker + the row raw-view.
const router = express.Router();
router.use(authenticateToken);

// How many recent deliveries the sample picker lists. First events are often
// pings / partial payloads, so the user picks from the last N.
const RECENT_DELIVERIES_LIMIT = 25;

// GET /:id/webhook-deliveries — recent deliveries (newest first), WITH payloads
// (capped count, each already <= 512KB) so the drawer can render the JsonTree
// sample picker without a second round-trip per item.
router.get('/:id/webhook-deliveries', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.json({ deliveries: [] });

  const limit = clampLimit(req.query.limit);
  const rows = db.prepare(
    `SELECT id, row_id, payload, payload_bytes, status, error_message, received_at
       FROM webhook_deliveries WHERE source_id = ?
       ORDER BY received_at DESC, id DESC LIMIT ?`,
  ).all(src.id, limit) as Array<{
    id: string; row_id: string | null; payload: string; payload_bytes: number;
    status: string; error_message: string | null; received_at: string;
  }>;

  res.json({
    deliveries: rows.map(r => ({
      id: r.id,
      rowId: r.row_id,
      // A pruned delivery kept its row but dropped the raw JSON (retention cap).
      retained: r.status !== 'pruned' && r.payload_bytes > 0,
      payload: r.status === 'pruned' ? null : safeParse(r.payload),
      payloadBytes: r.payload_bytes,
      status: r.status,
      errorMessage: r.error_message,
      receivedAt: r.received_at,
    })),
  });
});

// GET /:id/webhook-deliveries/:rowId — raw payload for the delivery that created
// a specific row. The grid only knows a row's CURRENT row_index (not its stable
// rows.id), so this variant resolves index -> id first, then the delivery. MUST
// be registered before /:rowId so "by-row-index" isn't captured as a rowId.
router.get('/:id/webhook-deliveries/by-row-index/:rowIndex', (req: AuthRequest, res) => {
  const { id, rowIndex } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });
  const idx = parseInt(rowIndex, 10);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Bad row index.' });
  const row = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index = ?')
    .get(id, req.userId!, idx) as { id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Row not found.' });
  return sendRawForRow(res, src.id, req.userId!, row.id);
});

// a specific row (the row-level "View webhook payload" action). Ownership-checked.
// 404 if the row has no (retained) delivery — pruning may have dropped the raw.
router.get('/:id/webhook-deliveries/:rowId', (req: AuthRequest, res) => {
  const { id, rowId } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });
  return sendRawForRow(res, src.id, req.userId!, rowId);
});

// Shared raw-delivery responder for both lookups (by row_id and by row_index).
function sendRawForRow(res: express.Response, sourceId: string, userId: string, rowId: string) {
  const delivery = db.prepare(
    `SELECT payload, payload_bytes, status, error_message, received_at
       FROM webhook_deliveries
       WHERE source_id = ? AND user_id = ? AND row_id = ?
       ORDER BY received_at DESC LIMIT 1`,
  ).get(sourceId, userId, rowId) as {
    payload: string; payload_bytes: number; status: string;
    error_message: string | null; received_at: string;
  } | undefined;

  if (!delivery) {
    return res.status(404).json({ error: 'No delivery recorded for this row.' });
  }
  const retained = delivery.status !== 'pruned' && delivery.payload_bytes > 0;
  return res.json({
    retained,
    payload: retained ? safeParse(delivery.payload) : null,
    payloadBytes: delivery.payload_bytes,
    status: delivery.status,
    errorMessage: delivery.error_message,
    receivedAt: delivery.received_at,
  });
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return RECENT_DELIVERIES_LIMIT;
  return Math.min(n, RECENT_DELIVERIES_LIMIT);
}

// Stored payload is text we serialized at ingest; parse for the client, but never
// throw if it's somehow not JSON (return the raw string as a fallback).
function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export default router;
