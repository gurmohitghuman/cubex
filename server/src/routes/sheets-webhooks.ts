import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import {
  getSourceForSheet, serializeSource, listMappings, createSourceWithColumn,
  rotateSource,
} from '../lib/webhook-service';
import { addWebhookMapping } from '../services/webhook-mapping-add';
import { dropWebhookBucket } from '../lib/webhook-bucket';
import { logSheetChange } from '../lib/change-log';

// Authenticated webhook management for a sheet. Mounted under /api/sheets via the
// sheets aggregator, so every route proves req.userId owns :id (the Cubex pattern).
const router = express.Router();
router.use(authenticateToken);

// GET /:id/webhook — the source (client-safe, URL masked after first event) +
// its mappings. 200 with { source: null } when none exists.
router.get('/:id/webhook', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.json({ source: null, mappings: [] });
  res.json({ source: serializeSource(src), mappings: listMappings(src.id) });
});

// POST /:id/webhook — create the one webhook for this sheet. 409 if one exists.
router.post('/:id/webhook', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  if (getSourceForSheet(id, req.userId!)) {
    return res.status(409).json({ error: 'This sheet already has a webhook.' });
  }
  const name = typeof req.body?.name === 'string' && req.body.name.trim()
    ? req.body.name.trim().slice(0, 100) : 'Webhook';
  // Adding the marker column counts toward the column cap.
  if (getSheetColumns(id, req.userId!).length >= MAX_COLUMNS_PER_SHEET) {
    return res.status(400).json({ error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet).` });
  }
  const { source } = createSourceWithColumn(id, req.userId!, name);
  logSheetChange(id, req.userId!, 'webhook', 'Added a webhook to the sheet');
  res.status(201).json({ source: serializeSource(source), mappings: [] });
});

// POST /:id/webhook/rotate — issue a new secret; old URL dies immediately.
router.post('/:id/webhook/rotate', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });
  rotateSource(src);
  logSheetChange(id, req.userId!, 'webhook', 'Made a new webhook URL (the old one stopped working)');
  const fresh = getSourceForSheet(id, req.userId!)!;
  res.json({ source: serializeSource(fresh) });
});

// PATCH /:id/webhook — enable/disable (the only mutable settings in v1).
router.patch('/:id/webhook', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required.' });
  db.prepare("UPDATE webhook_sources SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
    .run(enabled ? 1 : 0, src.id);
  logSheetChange(id, req.userId!, 'webhook', `Turned the webhook ${enabled ? 'on' : 'off'}`);
  res.json({ source: serializeSource(getSourceForSheet(id, req.userId!)!) });
});

// DELETE /:id/webhook — remove the source (cascade drops mappings + deliveries).
// Frees the marker column for deletion. Drops the rate-limit bucket.
router.delete('/:id/webhook', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });
  db.prepare('DELETE FROM webhook_sources WHERE id = ? AND user_id = ?').run(src.id, req.userId!);
  dropWebhookBucket(src.id); // free the per-source rate-limit bucket
  logSheetChange(id, req.userId!, 'webhook', 'Deleted the webhook');
  res.json({ message: 'Webhook deleted.' });
});

// POST /:id/webhook/mappings — create a mapping + its target column, which
// only lists the column: no row is written (services/webhook-mapping-add.ts).
router.post('/:id/webhook/mappings', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });

  const out = addWebhookMapping(id, req.userId!, src.id, {
    jsonPath: typeof req.body?.jsonPath === 'string' ? req.body.jsonPath.trim() : '',
    columnName: typeof req.body?.columnName === 'string' ? req.body.columnName : '',
    valueMode: req.body?.valueMode === 'json' ? 'json' : 'scalar',
  });
  if ('fail' in out) {
    if (out.fail === 'busy') return res.status(409).json({ error: out.error, busy: true });
    return res.status(400).json({ error: out.error });
  }
  res.status(201).json({ mappings: listMappings(src.id) });
});

// DELETE /:id/webhook/mappings/:mappingId — remove the mapping ONLY (keep the
// column + its data). Deleting the column itself goes through the column route.
router.delete('/:id/webhook/mappings/:mappingId', (req: AuthRequest, res) => {
  const { id, mappingId } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });
  const r = db.prepare('DELETE FROM webhook_mappings WHERE id = ? AND source_id = ? AND user_id = ?')
    .run(mappingId, src.id, req.userId!);
  if (r.changes === 0) return res.status(404).json({ error: 'Mapping not found.' });
  logSheetChange(id, req.userId!, 'webhook', 'Removed a field the webhook filled (its column stays)');
  res.json({ mappings: listMappings(src.id) });
});

export default router;
