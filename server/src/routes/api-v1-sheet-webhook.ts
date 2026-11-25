// /api/v1/sheets/:id/webhook: a sheet's incoming webhook over the API (docs/webhooks.md). Thin wrappers over
// services/sheet-webhook.ts, shared with the app's Webhook drawer and the manage_sheet_webhook tool. Reading
// needs 'read'; every change needs 'write', and so does seeing the URL (Gurmohit, 2026-11-06: whoever may
// change the sheet may see and rotate it). The busy-sheet rule for changes is api-v1.ts's, as for every
// /sheets/:id route.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import {
  addSheetWebhookField, createSheetWebhook, deleteSheetWebhook, getSheetWebhook, newSheetWebhookToken,
  removeSheetWebhookAutoDelete, removeSheetWebhookField, removeSheetWebhookToken, rotateSheetWebhook,
  setSheetWebhookAutoDelete, setSheetWebhookEnabled, sheetWebhookView, type SheetWebhookFail, type SheetWebhookOutcome,
} from '../services/sheet-webhook';
import type { WebhookSourceFull } from '../lib/webhook-service';
import { linkBase } from '../lib/file-links';

const router = express.Router();

const STATUS: Record<SheetWebhookFail['fail'], number> = { bad_request: 400, not_found: 404, conflict: 409 };
const body = (req: express.Request) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

// The answer: { webhook } with the URL (the caller has 'write'), or the refusal.
function reply(
  req: express.Request, res: express.Response, out: SheetWebhookOutcome<WebhookSourceFull>, created = false,
) {
  if ('fail' in out) {
    return res.status(STATUS[out.fail]).json({ error: out.message, ...(out.busy ? { busy: true } : {}) });
  }
  res.status(created ? 201 : 200).json({ webhook: sheetWebhookView(out.ok, linkBase(req)) });
}

const guarded = (route: string, fn: (req: TokenAuthRequest, res: express.Response) => unknown) =>
  (req: TokenAuthRequest, res: express.Response) => {
    try {
      fn(req, res);
    } catch (error) {
      console.error(`${route} error:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'Webhook request failed' });
    }
  };

// GET: { webhook } (null when the sheet has none). The URL only for a key with 'write'.
router.get('/sheets/:id/webhook', requireScope('read'), guarded('GET /v1/sheets/:id/webhook', (req, res) => {
  const out = getSheetWebhook(req.userId!, req.params.id);
  if ('fail' in out) return res.status(STATUS[out.fail]).json({ error: out.message });
  res.json({ webhook: out.ok && sheetWebhookView(out.ok, req.tokenScopes?.has('write') ? linkBase(req) : null) });
}));

// POST: give the sheet its webhook. 201 { webhook } with its URL; 409 when it has one.
router.post('/sheets/:id/webhook', requireScope('write'), guarded('POST /v1/sheets/:id/webhook', (req, res) =>
  reply(req, res, createSheetWebhook(req.userId!, req.params.id), true)));

// PATCH { enabled }: turn it on or off.
router.patch('/sheets/:id/webhook', requireScope('write'), guarded('PATCH /v1/sheets/:id/webhook', (req, res) =>
  reply(req, res, setSheetWebhookEnabled(req.userId!, req.params.id, body(req).enabled))));

// POST rotate: a new URL, in the answer; the old one stops at once.
router.post('/sheets/:id/webhook/rotate', requireScope('write'),
  guarded('POST /v1/sheets/:id/webhook/rotate', (req, res) =>
    reply(req, res, rotateSheetWebhook(req.userId!, req.params.id))));

// POST token: a new token senders must send as Authorization: Bearer <token>; { webhook, token }, the only time
// the token is shown. Any old one stops at once.
router.post('/sheets/:id/webhook/token', requireScope('write'),
  guarded('POST /v1/sheets/:id/webhook/token', (req, res) => {
    const out = newSheetWebhookToken(req.userId!, req.params.id);
    if ('fail' in out) return reply(req, res, out);
    res.json({ webhook: sheetWebhookView(out.ok.source, linkBase(req)), token: out.ok.token });
  }));

// DELETE token: senders no longer need one.
router.delete('/sheets/:id/webhook/token', requireScope('write'),
  guarded('DELETE /v1/sheets/:id/webhook/token', (req, res) =>
    reply(req, res, removeSheetWebhookToken(req.userId!, req.params.id))));

// DELETE: remove the webhook and its kept events. Its columns and rows stay.
router.delete('/sheets/:id/webhook', requireScope('write'), guarded('DELETE /v1/sheets/:id/webhook', (req, res) => {
  const out = deleteSheetWebhook(req.userId!, req.params.id);
  if ('fail' in out) return res.status(STATUS[out.fail]).json({ error: out.message });
  res.json({ deleted: true });
}));

// PUT auto-delete { mode?, where?, keep_rows?, success_column?, copy_to_sheet_id? }: turn it on or change it (mode
// rules: rows leave once they pass where, read_rows' language). What it leaves out
// stays (on a first PUT: 100 rows kept, no success column, no copy); null clears; any other field is a 400.
router.put('/sheets/:id/webhook/auto-delete', requireScope('write'),
  guarded('PUT /v1/sheets/:id/webhook/auto-delete', (req, res) =>
    reply(req, res, setSheetWebhookAutoDelete(req.userId!, req.params.id, body(req)))));

// DELETE auto-delete: turn it off. Rows already gone stay gone.
router.delete('/sheets/:id/webhook/auto-delete', requireScope('write'),
  guarded('DELETE /v1/sheets/:id/webhook/auto-delete', (req, res) =>
    reply(req, res, removeSheetWebhookAutoDelete(req.userId!, req.params.id))));

// POST fields { json_path, column, as? }: each event's value at json_path fills a new column, as text
// (default) or as JSON.
router.post('/sheets/:id/webhook/fields', requireScope('write'),
  guarded('POST /v1/sheets/:id/webhook/fields', (req, res) => {
    const b = body(req);
    if (b.as !== undefined && b.as !== 'text' && b.as !== 'json') {
      return res.status(400).json({ error: 'as is "text" or "json".' });
    }
    const out = addSheetWebhookField(req.userId!, req.params.id,
      { jsonPath: b.json_path, column: b.column, asJson: b.as === 'json' });
    reply(req, res, 'fail' in out ? out : { ok: out.ok.source }, true);
  }));

// DELETE fields/:fieldId: stop filling a field. Its column and values stay.
router.delete('/sheets/:id/webhook/fields/:fieldId', requireScope('write'),
  guarded('DELETE /v1/sheets/:id/webhook/fields/:fieldId', (req, res) =>
    reply(req, res, removeSheetWebhookField(req.userId!, req.params.id, req.params.fieldId))));

export default router;
