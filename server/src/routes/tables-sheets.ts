import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { validateSheetName } from '../lib/sheet-validation';
import { abortRunsForSheets } from '../services/run-control';
import { dropBucketsForSheets } from '../lib/webhook-bucket';
import {
  verifyTableOwnership, verifySheetInTable, listSheets, getSheetForClient,
  sheetNameTaken, createSheetTxn,
} from '../lib/sheet-crud-helpers';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { normalizeNameSpacing } from '../lib/name-safety';

// Sheet (tab) CRUD, mounted under /api/tables/:tableId/sheets. The /api/sheets
// prefix stays for per-sheet DATA ops (data, columns, import-into-existing, webhook).
// Every route verifies the table is owned by the caller; mutations run inside one
// BEGIN IMMEDIATE txn; all return the authoritative { sheets } list so the client
// reconciles (handles multi-tab / multi-device sheet-list drift).
const router = express.Router({ mergeParams: true });
router.use(authenticateToken);

// POST /:tableId/sheets — create a sheet. Body { name?, afterSheetId? }.
router.post('/', (req: AuthRequest, res) => {
  try {
    const tableId = req.params.tableId;
    if (!tableId || !UUID_PATTERN.test(tableId)) {
      return res.status(400).json({ error: 'Invalid table ID format' });
    }
    if (!verifyTableOwnership(tableId, req.userId!)) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const { name, afterSheetId } = req.body as { name?: string; afterSheetId?: string };
    let trimmedName: string | undefined;
    if (name !== undefined) {
      const err = validateSheetName(name);
      if (err) return res.status(400).json({ error: err });
      trimmedName = normalizeNameSpacing(name as string);
    }

    const result = createSheetTxn(tableId, req.userId!, trimmedName, afterSheetId);
    if (!result.ok) {
      return res.status(400).json({ error: `A sheet named "${trimmedName}" already exists in this table` });
    }

    const sheet = getSheetForClient(result.sheetId, req.userId!);
    res.status(201).json({ sheet, sheets: listSheets(tableId, req.userId!) });
  } catch (error) {
    console.error('Create sheet error:', error);
    res.status(500).json({ error: 'Failed to create sheet' });
  }
});

// PATCH /:tableId/sheets/reorder — body { orderedSheetIds }. MUST precede /:sheetId.
router.patch('/reorder', (req: AuthRequest, res) => {
  try {
    const tableId = req.params.tableId;
    if (!verifyTableOwnership(tableId, req.userId!)) {
      return res.status(404).json({ error: 'Table not found' });
    }
    const { orderedSheetIds } = req.body as { orderedSheetIds?: unknown };
    if (!Array.isArray(orderedSheetIds) || orderedSheetIds.some(x => typeof x !== 'string')) {
      return res.status(400).json({ error: 'orderedSheetIds must be an array of sheet ids' });
    }

    let bad = false;
    db.transaction(() => {
      const current = (db.prepare(
        'SELECT id FROM sheets WHERE table_id = ? AND user_id = ?',
      ).all(tableId, req.userId!) as Array<{ id: string }>).map(r => r.id);
      // The provided set must EXACTLY match the table's sheets (same members, no dups).
      const a = [...current].sort();
      const b = [...(orderedSheetIds as string[])].sort();
      if (a.length !== b.length || a.some((id, i) => id !== b[i])) { bad = true; return; }

      const setPos = db.prepare('UPDATE sheets SET position = ? WHERE id = ? AND user_id = ?');
      (orderedSheetIds as string[]).forEach((id, i) => setPos.run(i, id, req.userId!));
    }).immediate();

    if (bad) return res.status(400).json({ error: 'orderedSheetIds must match the table’s sheets exactly' });
    res.json({ sheets: listSheets(tableId, req.userId!) });
  } catch (error) {
    console.error('Reorder sheets error:', error);
    res.status(500).json({ error: 'Failed to reorder sheets' });
  }
});

// PATCH /:tableId/sheets/:sheetId — rename. Body { name }.
router.patch('/:sheetId', (req: AuthRequest, res) => {
  try {
    const { tableId, sheetId } = req.params;
    if (!verifyTableOwnership(tableId, req.userId!)) {
      return res.status(404).json({ error: 'Table not found' });
    }
    const err = validateSheetName(req.body?.name);
    if (err) return res.status(400).json({ error: err });
    const trimmedName = normalizeNameSpacing(req.body.name as string);

    let notFound = false;
    let conflict = false;
    db.transaction(() => {
      if (!verifySheetInTable(sheetId, tableId, req.userId!)) { notFound = true; return; }
      if (sheetNameTaken(tableId, req.userId!, trimmedName, sheetId)) { conflict = true; return; }
      db.prepare("UPDATE sheets SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(trimmedName, sheetId, req.userId!);
    }).immediate();

    if (notFound) return res.status(404).json({ error: 'Sheet not found' });
    if (conflict) return res.status(400).json({ error: `A sheet named "${trimmedName}" already exists in this table` });

    const sheet = getSheetForClient(sheetId, req.userId!);
    res.json({ sheet, sheets: listSheets(tableId, req.userId!) });
  } catch (error) {
    console.error('Rename sheet error:', error);
    res.status(500).json({ error: 'Failed to rename sheet' });
  }
});

// DELETE /:tableId/sheets/:sheetId — reject if last sheet; abort runs + capture
// webhook source ids BEFORE the cascade delete; drop their buckets AFTER commit.
router.delete('/:sheetId', (req: AuthRequest, res) => {
  try {
    const { tableId, sheetId } = req.params;
    if (!verifyTableOwnership(tableId, req.userId!)) {
      return res.status(404).json({ error: 'Table not found' });
    }
    if (!verifySheetInTable(sheetId, tableId, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const busy = sheetBusyWith(sheetId);
    if (busy) return res.status(409).json({ error: busyMessage(busy), busy: true });

    // The last-sheet guard + the DELETE must be atomic (BEGIN IMMEDIATE): two concurrent
    // deletes of the last two sheets could otherwise both pass a non-txn count check and
    // both delete, leaving a zero-sheet table. Everything that mutates DB state lives in
    // the txn; run-abort + source-id capture happen INSIDE too (after the count check
    // passes) so a delete that LOSES the last-sheet race and 400s never cancels runs on a
    // surviving sheet. Bucket drop is in-memory → runs POST-commit (must not fire on rollback).
    let isLastSheet = false;
    let sourceIds: string[] = [];
    db.transaction(() => {
      const { c } = db.prepare(
        'SELECT COUNT(*) AS c FROM sheets WHERE table_id = ? AND user_id = ?',
      ).get(tableId, req.userId!) as { c: number };
      if (c <= 1) { isLastSheet = true; return; }

      sourceIds = (db.prepare(
        'SELECT id FROM webhook_sources WHERE sheet_id = ?',
      ).all(sheetId) as Array<{ id: string }>).map(r => r.id);
      abortRunsForSheets([sheetId]);
      db.prepare('DELETE FROM sheets WHERE id = ? AND user_id = ?').run(sheetId, req.userId!);
    }).immediate();

    if (isLastSheet) {
      return res.status(400).json({ error: 'A table must have at least one sheet.' });
    }
    dropBucketsForSheets(sourceIds);

    res.json({ sheets: listSheets(tableId, req.userId!) });
  } catch (error) {
    console.error('Delete sheet error:', error);
    res.status(500).json({ error: 'Failed to delete sheet' });
  }
});

export default router;
