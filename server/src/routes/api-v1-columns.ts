// /v1 column lifecycle: add (mirrors sheets-columns-mutate.ts inline), rename/
// delete/reorder (the shared cascade services — one implementation with the UI
// routes). v1 status-code note: name collisions are 409 (the UI's historical
// 400 stays); every mutation bumps data_version so open tabs repaint.
import express from 'express';
import { db } from '../lib/db';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { addSheetColumn } from '../services/column-add';
import { renameSheetColumn } from '../services/column-rename';
import { deleteSheetColumn } from '../services/column-delete';
import { reorderSheetColumns } from '../services/column-reorder';

const router = express.Router();

function ownsSheet(sheetId: string, userId: string): boolean {
  return !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);
}

// POST /v1/sheets/:id/columns — add via the shared service (collision 409).
router.post('/sheets/:id/columns', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const sheetId = req.params.id;
    if (!ownsSheet(sheetId, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });

    const { name } = req.body as { name?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const result = addSheetColumn(sheetId, req.userId!, name, { bumpDataVersion: true, seedEmptyRow: false });
    if ('fail' in result) {
      return res.status(result.fail === 'collision' ? 409 : 400).json({ error: result.error });
    }
    res.status(201).json({ name: result.name });
  } catch (error) {
    console.error('POST /v1/sheets/:id/columns error:', error);
    res.status(500).json({ error: 'Failed to add column' });
  }
});

// PUT /v1/sheets/:id/columns/order {order: string[]} — full-set reorder.
// Registered before the /:name routes only for readability; PUT vs PATCH/DELETE
// methods can't actually collide on the wildcard.
router.put('/sheets/:id/columns/order', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    if (!ownsSheet(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const result = reorderSheetColumns(
      req.params.id, req.userId!, (req.body as { order?: unknown }).order, { bumpDataVersion: true },
    );
    if ('fail' in result) return res.status(400).json({ error: result.error });
    res.json({ order: (req.body as { order: string[] }).order });
  } catch (error) {
    console.error('PUT /v1/sheets/:id/columns/order error:', error);
    res.status(500).json({ error: 'Failed to reorder columns' });
  }
});

// PATCH /v1/sheets/:id/columns/:name {name} — rename via the shared cascade
// service (rows.data key, column_order, filters, HTTP-run +
// http_column_associations + webhook refs, active-run 409).
router.patch('/sheets/:id/columns/:name', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    if (!ownsSheet(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const { name } = req.body as { name?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const result = await renameSheetColumn(
      req.params.id, req.userId!, req.params.name, name, { bumpDataVersion: true },
    );
    if ('fail' in result) {
      switch (result.fail) {
        case 'column_not_found':
          return res.status(404).json({ error: `Column "${req.params.name}" not found in this sheet` });
        case 'collision':
          return res.status(409).json({ error: result.error });
        case 'active_run':
        case 'busy':
          return res.status(409).json({ error: result.error });
        default:
          return res.status(400).json({ error: result.error });
      }
    }
    res.json({ name: result.newName });
  } catch (error) {
    console.error('PATCH /v1/sheets/:id/columns/:name error:', error);
    res.status(500).json({ error: 'Failed to rename column' });
  }
});

// DELETE /v1/sheets/:id/columns/:name — via the shared cascade service
// (active-run 409, webhook raw-marker + last-column 400s, full cleanup).
router.delete('/sheets/:id/columns/:name', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    if (!ownsSheet(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const result = await deleteSheetColumn(req.params.id, req.userId!, req.params.name, { bumpDataVersion: true });
    if ('fail' in result) {
      switch (result.fail) {
        case 'column_not_found':
          return res.status(404).json({ error: `Column "${req.params.name}" not found in this sheet` });
        case 'active_run':
        case 'busy':
          return res.status(409).json({ error: result.error });
        default: // 'webhook_column' | 'last_column'
          return res.status(400).json({ error: result.error });
      }
    }
    res.json({ deleted: true });
  } catch (error) {
    console.error('DELETE /v1/sheets/:id/columns/:name error:', error);
    res.status(500).json({ error: 'Failed to delete column' });
  }
});

export default router;
