import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { serializeSource, listMappings, type WebhookSourceFull } from '../lib/webhook-service';
import {
  addSheetWebhookField, createSheetWebhook, deleteSheetWebhook, getSheetWebhook, newSheetWebhookToken,
  removeSheetWebhookAutoDelete, removeSheetWebhookField, removeSheetWebhookToken, rotateSheetWebhook,
  setSheetWebhookAutoDelete, setSheetWebhookEnabled, type SheetWebhookFail,
} from '../services/sheet-webhook';
import { autoDeleteView } from '../services/webhook-auto-delete';

// The app's webhook management for a sheet (the Webhook drawer). Mounted under /api/sheets via the sheets
// aggregator. Thin wrappers over services/sheet-webhook.ts, which /api/v1 and MCP share, so the three can't
// drift; only the answer's shape (camelCase, the drawer's) is this file's own.
const router = express.Router();
router.use(authenticateToken);

const STATUS: Record<SheetWebhookFail['fail'], number> = { bad_request: 400, not_found: 404, conflict: 409 };
const refuse = (res: express.Response, out: SheetWebhookFail) =>
  res.status(STATUS[out.fail]).json({ error: out.message, ...(out.busy ? { busy: true } : {}) });
// With auto-delete's settings and counts (services/webhook-auto-delete.ts), null while off.
function source(src: WebhookSourceFull): Record<string, unknown> {
  const a = autoDeleteView(src.id);
  return {
    ...serializeSource(src),
    autoDelete: a && {
      mode: a.mode, where: a.where, keepRows: a.keep_rows, successColumn: a.success_column,
      copyToSheetId: a.copy_to_sheet_id,
      copyToSheet: a.copy_to_sheet, paused: a.paused, waiting: a.waiting, rowsDeleted: a.rows_deleted,
      lastDeletedAt: a.last_deleted_at,
    },
  };
}

// GET /:id/webhook: the source (URL shown until the first event) and its mappings; { source: null } when none.
router.get('/:id/webhook', (req: AuthRequest, res) => {
  const out = getSheetWebhook(req.userId!, req.params.id);
  if ('fail' in out) return refuse(res, out);
  if (!out.ok) return res.json({ source: null, mappings: [] });
  res.json({ source: source(out.ok), mappings: listMappings(out.ok.id) });
});

// POST /:id/webhook: create the one webhook for this sheet. 409 if one exists.
router.post('/:id/webhook', (req: AuthRequest, res) => {
  const out = createSheetWebhook(req.userId!, req.params.id, req.body?.name);
  if ('fail' in out) return refuse(res, out);
  res.status(201).json({ source: source(out.ok), mappings: [] });
});

// POST /:id/webhook/rotate: a new secret; the old URL stops at once.
router.post('/:id/webhook/rotate', (req: AuthRequest, res) => {
  const out = rotateSheetWebhook(req.userId!, req.params.id);
  if ('fail' in out) return refuse(res, out);
  res.json({ source: source(out.ok) });
});

// PATCH /:id/webhook: turn it on or off.
router.patch('/:id/webhook', (req: AuthRequest, res) => {
  const out = setSheetWebhookEnabled(req.userId!, req.params.id, req.body?.enabled);
  if ('fail' in out) return refuse(res, out);
  res.json({ source: source(out.ok) });
});

// POST /:id/webhook/token: a new token senders must send, shown once in the answer; any old one stops.
router.post('/:id/webhook/token', (req: AuthRequest, res) => {
  const out = newSheetWebhookToken(req.userId!, req.params.id);
  if ('fail' in out) return refuse(res, out);
  res.json({ source: source(out.ok.source), token: out.ok.token });
});

// DELETE /:id/webhook/token: senders no longer need a token.
router.delete('/:id/webhook/token', (req: AuthRequest, res) => {
  const out = removeSheetWebhookToken(req.userId!, req.params.id);
  if ('fail' in out) return refuse(res, out);
  res.json({ source: source(out.ok) });
});

// PUT /:id/webhook/auto-delete { mode, where, keepRows, successColumn, copyToSheetId }: turn it on or change it
// (the drawer sends them all; null clears).
router.put('/:id/webhook/auto-delete', (req: AuthRequest, res) => {
  const b = req.body ?? {};
  const out = setSheetWebhookAutoDelete(req.userId!, req.params.id,
    { mode: b.mode, where: b.where, keep_rows: b.keepRows, success_column: b.successColumn,
      copy_to_sheet_id: b.copyToSheetId });
  if ('fail' in out) return refuse(res, out);
  res.json({ source: source(out.ok) });
});

// DELETE /:id/webhook/auto-delete: turn it off.
router.delete('/:id/webhook/auto-delete', (req: AuthRequest, res) => {
  const out = removeSheetWebhookAutoDelete(req.userId!, req.params.id);
  if ('fail' in out) return refuse(res, out);
  res.json({ source: source(out.ok) });
});

// DELETE /:id/webhook: remove the source (its mappings and deliveries go with it). Frees the marker column.
router.delete('/:id/webhook', (req: AuthRequest, res) => {
  const out = deleteSheetWebhook(req.userId!, req.params.id);
  if ('fail' in out) return refuse(res, out);
  res.json({ message: 'Webhook deleted.' });
});

// POST /:id/webhook/mappings: a mapping and its new column, which only lists the column: no row is written.
router.post('/:id/webhook/mappings', (req: AuthRequest, res) => {
  const out = addSheetWebhookField(req.userId!, req.params.id, {
    jsonPath: req.body?.jsonPath, column: req.body?.columnName, asJson: req.body?.valueMode === 'json',
  });
  if ('fail' in out) return refuse(res, out);
  res.status(201).json({ mappings: listMappings(out.ok.source.id) });
});

// DELETE /:id/webhook/mappings/:mappingId: the mapping only; its column and data stay.
router.delete('/:id/webhook/mappings/:mappingId', (req: AuthRequest, res) => {
  const out = removeSheetWebhookField(req.userId!, req.params.id, req.params.mappingId);
  if ('fail' in out) return refuse(res, out);
  res.json({ mappings: listMappings(out.ok.id) });
});

export default router;
