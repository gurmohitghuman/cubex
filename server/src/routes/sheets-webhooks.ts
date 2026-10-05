import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import {
  appendColumnsToOrder, getSheetColumns, jsonPath,
  touchSheet, verifySheetOwnership,
} from '../lib/sql-helpers';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';
import {
  getSourceForSheet, serializeSource, listMappings, createSourceWithColumn,
  rotateSource,
} from '../lib/webhook-service';
import { validateMappingPath } from '../lib/jsonpath-extract';
import { dropWebhookBucket } from '../lib/webhook-bucket';

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
  res.status(201).json({ source: serializeSource(source), mappings: [] });
});

// POST /:id/webhook/rotate — issue a new secret; old URL dies immediately.
router.post('/:id/webhook/rotate', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });
  rotateSource(src);
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
  res.json({ message: 'Webhook deleted.' });
});

// POST /:id/webhook/mappings — create a mapping + its target column (transactional).
router.post('/:id/webhook/mappings', (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!verifySheetOwnership(id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const src = getSourceForSheet(id, req.userId!);
  if (!src) return res.status(404).json({ error: 'No webhook on this sheet.' });

  const rawPath = typeof req.body?.jsonPath === 'string' ? req.body.jsonPath.trim() : '';
  const rawCol = typeof req.body?.columnName === 'string' ? req.body.columnName : '';
  const valueMode = req.body?.valueMode === 'json' ? 'json' : 'scalar';
  // Validate the path against the client builder grammar + length cap BEFORE
  // storing it — a stored mapping path runs on every unauthenticated webhook POST,
  // so a hand-crafted filter/script path must be rejected here, not at run time.
  const pathCheck = validateMappingPath(rawPath);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.reason });

  const nameCheck = sanitizeAndValidateColumnName(rawCol);
  if ('error' in nameCheck) return res.status(400).json({ error: nameCheck.error });
  const columnName = nameCheck.name;

  const existingCols = getSheetColumns(id, req.userId!);
  const collision = findColumnNameCollision(columnName, existingCols);
  if (collision) return res.status(400).json({ error: columnCollisionMessage(columnName, collision) });
  if (existingCols.length >= MAX_COLUMNS_PER_SHEET) {
    return res.status(400).json({ error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet).` });
  }

  const mappingId = uuidv4();
  db.transaction(() => {
    // Create the target column (empty on every existing row), append to order.
    const rowIds = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND user_id = ?')
      .all(id, req.userId!) as Array<{ id: string }>;
    if (rowIds.length > 0) {
      const setEmpty = db.prepare(
        "UPDATE rows SET data = json_set(data, ?, ''), updated_at = datetime('now') WHERE id = ?",
      );
      const path = jsonPath(columnName);
      for (const r of rowIds) setEmpty.run(path, r.id);
    } else {
      db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, 0, ?)')
        .run(uuidv4(), id, req.userId!, JSON.stringify({ [columnName]: '' }));
    }
    appendColumnsToOrder(id, req.userId!, [columnName]);
    db.prepare(
      `INSERT INTO webhook_mappings (id, source_id, user_id, json_path, column_name, value_mode)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(mappingId, src.id, req.userId!, rawPath, columnName, valueMode);
    touchSheet(id, req.userId!);
  })();

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
  res.json({ mappings: listMappings(src.id) });
});

export default router;
