import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { serializeSource, listMappings, type WebhookSourceFull } from '../lib/webhook-service';
import {
  addSheetWebhookField, createSheetWebhook, deleteSheetWebhook, getSheetWebhook, removeSheetWebhookField,
  rotateSheetWebhook, setSheetWebhookEnabled, type SheetWebhookFail,
} from '../services/sheet-webhook';

// The app's webhook management for a sheet (the Webhook drawer). Mounted under /api/sheets via the sheets
// aggregator. Thin wrappers over services/sheet-webhook.ts, which /api/v1 and MCP share, so the three can't
// drift; only the answer's shape (camelCase, the drawer's) is this file's own.
const router = express.Router();
router.use(authenticateToken);

const STATUS: Record<SheetWebhookFail['fail'], number> = { bad_request: 400, not_found: 404, conflict: 409 };
const refuse = (res: express.Response, out: SheetWebhookFail) =>
  res.status(STATUS[out.fail]).json({ error: out.message, ...(out.busy ? { busy: true } : {}) });
const source = (src: WebhookSourceFull) => serializeSource(src);

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
