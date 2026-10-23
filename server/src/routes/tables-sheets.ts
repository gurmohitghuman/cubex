import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { validateSheetName } from '../lib/sheet-validation';
import {
  verifyTableOwnership, verifySheetInTable, listSheets, getSheetForClient, createSheetTxn,
} from '../lib/sheet-crud-helpers';
import { deleteSheet, renameSheet, reorderSheets } from '../services/sheet-crud';
import { copySheetValues, copyFailStatus } from '../services/sheet-copy';
import { getTrashDays } from '../lib/trash/store';
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

// Reorder, rename and delete share services/sheet-crud.ts with /api/v1 and
// MCP. The app keeps its historical status codes: a name conflict is 400 here
// (v1 answers 409), not-found 404; a busy sheet is 409, checked first.
const uiStatus = (f: { fail: string }): number => (f.fail === 'not_found' ? 404 : 400);

// PATCH /:tableId/sheets/reorder — body { orderedSheetIds }. MUST precede /:sheetId.
router.patch('/reorder', (req: AuthRequest, res) => {
  try {
    const { orderedSheetIds } = req.body as { orderedSheetIds?: unknown };
    if (!Array.isArray(orderedSheetIds) || orderedSheetIds.some(x => typeof x !== 'string')) {
      return res.status(400).json({ error: 'orderedSheetIds must be an array of sheet ids' });
    }
    const out = reorderSheets(req.userId!, req.params.tableId, orderedSheetIds as string[]);
    if ('fail' in out) {
      return res.status(uiStatus(out)).json({
        error: out.fail === 'not_found' ? out.message : 'orderedSheetIds must match the table’s sheets exactly',
      });
    }
    res.json({ sheets: out.ok.sheets });
  } catch (error) {
    console.error('Reorder sheets error:', error);
    res.status(500).json({ error: 'Failed to reorder sheets' });
  }
});

// POST /:tableId/sheets/:sheetId/copy — "Copy values to a new sheet" (services/sheet-copy.ts).
// Body { name? }. Answers once every row is in; a name conflict is 400, as on create.
router.post('/:sheetId/copy', async (req: AuthRequest, res) => {
  try {
    const { tableId, sheetId } = req.params;
    if (!verifySheetInTable(sheetId, tableId, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const out = await copySheetValues(req.userId!, sheetId, { name: req.body?.name });
    if ('fail' in out) {
      const status = out.fail === 'conflict' ? 400 : copyFailStatus(out.fail);
      return res.status(status).json({ error: out.message, ...(out.fail === 'busy' ? { busy: true } : {}) });
    }
    res.status(201).json({
      sheet: getSheetForClient(out.ok.sheet.id, req.userId!), sheets: out.ok.sheets, rowsCopied: out.ok.rowsCopied,
    });
  } catch (error) {
    console.error('Copy sheet error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to copy the sheet' });
  }
});

// PATCH /:tableId/sheets/:sheetId — rename. Body { name }.
router.patch('/:sheetId', (req: AuthRequest, res) => {
  try {
    const { tableId, sheetId } = req.params;
    const out = renameSheet(req.userId!, tableId, sheetId, req.body?.name);
    if ('fail' in out) return res.status(uiStatus(out)).json({ error: out.message });
    res.json({ sheet: getSheetForClient(sheetId, req.userId!), sheets: out.ok.sheets });
  } catch (error) {
    console.error('Rename sheet error:', error);
    res.status(500).json({ error: 'Failed to rename sheet' });
  }
});

// DELETE /:tableId/sheets/:sheetId — into the trash (services/trash-sheets.ts);
// the last sheet of a table can't go.
router.delete('/:sheetId', (req: AuthRequest, res) => {
  try {
    const { tableId, sheetId } = req.params;
    const busy = sheetBusyWith(sheetId);
    if (busy) return res.status(409).json({ error: busyMessage(busy), busy: true });
    const out = deleteSheet(req.userId!, tableId, sheetId);
    if ('fail' in out) return res.status(uiStatus(out)).json({ error: out.message });
    res.json({
      sheets: out.ok.sheets,
      trash: out.ok.trashId ? { id: out.ok.trashId, days: getTrashDays(req.userId!) } : null,
    });
  } catch (error) {
    console.error('Delete sheet error:', error);
    res.status(500).json({ error: 'Failed to delete sheet' });
  }
});

export default router;
