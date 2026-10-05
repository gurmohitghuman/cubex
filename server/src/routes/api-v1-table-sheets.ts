// /v1 sheet (tab) CRUD — thin wrappers over services/sheet-crud.ts (shared
// with the MCP manage_sheet tool), table-scoped like the UI routes.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { createSheet, renameSheet, deleteSheet, reorderSheets, SheetCrudOutcome } from '../services/sheet-crud';
import { tableFailHttpStatus } from '../services/table-crud';

const router = express.Router();

function send(res: express.Response, result: SheetCrudOutcome, created = false) {
  if ('fail' in result) return res.status(tableFailHttpStatus(result)).json({ error: result.message });
  res.status(created ? 201 : 200).json(result.ok);
}

// POST /v1/tables/:tableId/sheets {name?, after_sheet_id?}
router.post('/tables/:tableId/sheets', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const { name, after_sheet_id } = (req.body ?? {}) as { name?: unknown; after_sheet_id?: unknown };
    const after = typeof after_sheet_id === 'string' ? after_sheet_id : undefined;
    send(res, createSheet(req.userId!, req.params.tableId, name, after), true);
  } catch (error) {
    console.error('POST /v1/tables/:tableId/sheets error:', error);
    res.status(500).json({ error: 'Failed to create sheet' });
  }
});

// PATCH /v1/tables/:tableId/sheets/order {ordered_sheet_ids} — MUST be
// registered before /:sheetId so 'order' isn't captured as a sheet id.
router.patch('/tables/:tableId/sheets/order', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const { ordered_sheet_ids } = (req.body ?? {}) as { ordered_sheet_ids?: unknown };
    if (!Array.isArray(ordered_sheet_ids) || ordered_sheet_ids.some(x => typeof x !== 'string')) {
      return res.status(400).json({ error: 'ordered_sheet_ids must be an array of sheet ids' });
    }
    send(res, reorderSheets(req.userId!, req.params.tableId, ordered_sheet_ids as string[]));
  } catch (error) {
    console.error('PATCH /v1/tables/:tableId/sheets/order error:', error);
    res.status(500).json({ error: 'Failed to reorder sheets' });
  }
});

// PATCH /v1/tables/:tableId/sheets/:sheetId {name} — rename.
router.patch('/tables/:tableId/sheets/:sheetId', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    send(res, renameSheet(req.userId!, req.params.tableId, req.params.sheetId, (req.body ?? {}).name));
  } catch (error) {
    console.error('PATCH /v1/tables/:tableId/sheets/:sheetId error:', error);
    res.status(500).json({ error: 'Failed to rename sheet' });
  }
});

// DELETE /v1/tables/:tableId/sheets/:sheetId — last-sheet guard etc. in the service.
router.delete('/tables/:tableId/sheets/:sheetId', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const result = deleteSheet(req.userId!, req.params.tableId, req.params.sheetId);
    if ('fail' in result) return res.status(tableFailHttpStatus(result)).json({ error: result.message });
    res.json({ deleted: true, sheets: result.ok.sheets });
  } catch (error) {
    console.error('DELETE /v1/tables/:tableId/sheets/:sheetId error:', error);
    res.status(500).json({ error: 'Failed to delete sheet' });
  }
});

export default router;
