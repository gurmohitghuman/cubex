import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { listSheets, getSheetForClient, getTableForClient } from '../lib/sheet-crud-helpers';
import { sheetListKey } from '../lib/sheet-list-key';
import {
  createTable, renameTable, deleteTable, type TableCrudFail,
} from '../services/table-crud';

const router = express.Router();
router.use(authenticateToken);

// GET / — list user's tables with sheet ids and total row counts.
router.get('/', (req: AuthRequest, res) => {
  try {
    // Explicit client columns (no user_id) — this row is spread into the response
    // below, so `SELECT *` would leak the internal user_id.
    const tables = db.prepare(
      'SELECT id, name, created_at, updated_at FROM tables WHERE user_id = ? ORDER BY created_at DESC',
    ).all(req.userId!) as Array<{ id: string; name: string; created_at: string; updated_at: string }>;

    const allSheets = db.prepare(
      'SELECT id, table_id FROM sheets WHERE user_id = ?',
    ).all(req.userId!) as Array<{ id: string; table_id: string }>;

    // Row counts: one query per user, grouped by sheet_id. With row-oriented storage this
    // is a trivial COUNT(*) per sheet — no DISTINCT scan over millions of cell rows.
    const rowCountsBySheetId = new Map<string, number>();
    if (allSheets.length > 0) {
      const placeholders = allSheets.map(() => '?').join(',');
      const counts = db.prepare(`
        SELECT sheet_id, COUNT(*) AS c
        FROM rows
        WHERE user_id = ? AND sheet_id IN (${placeholders})
        GROUP BY sheet_id
      `).all(req.userId!, ...allSheets.map(s => s.id)) as Array<{ sheet_id: string; c: number }>;
      for (const row of counts) rowCountsBySheetId.set(row.sheet_id, row.c);
    }

    const sheetsByTable = new Map<string, Array<{ id: string }>>();
    for (const s of allSheets) {
      if (!sheetsByTable.has(s.table_id)) sheetsByTable.set(s.table_id, []);
      sheetsByTable.get(s.table_id)!.push({ id: s.id });
    }

    res.json(tables.map(t => {
      const sheets = sheetsByTable.get(t.id) || [];
      let totalRowCount = 0;
      for (const s of sheets) totalRowCount += rowCountsBySheetId.get(s.id) || 0;
      return { ...t, sheets, row_count: totalRowCount };
    }));
  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

// GET /:id — single table with its sheets.
router.get('/:id', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid table ID format' });

    const table = getTableForClient(id, req.userId!);
    if (!table) return res.status(404).json({ error: 'Table not found' });

    const sheets = listSheets(id, req.userId!);
    // sheets_key seeds the sheet change-poll's tab-list check (lib/sheet-list-key.ts).
    res.json({ ...(table as object), sheets, sheets_key: sheetListKey(id, req.userId!) });
  } catch (error) {
    console.error('Get table error:', error);
    res.status(500).json({ error: 'Failed to fetch table' });
  }
});

// Create / rename / delete share services/table-crud.ts with /api/v1 and the
// MCP manage_table tool. The UI keeps its historical status codes: a name
// conflict is 400 here (v1 answers 409), not-found 404.
const uiFailStatus = (f: TableCrudFail): number => (f.fail === 'not_found' ? 404 : 400);

// POST / — create a new table with one default (empty) sheet.
router.post('/', (req: AuthRequest, res) => {
  try {
    const result = createTable(req.userId!, req.body?.name);
    if ('fail' in result) return res.status(uiFailStatus(result)).json({ error: result.message });
    const table = getTableForClient(result.ok.id, req.userId!);
    const sheet = getSheetForClient(result.ok.sheetId, req.userId!);
    res.json({ ...(table as object), sheets: [sheet] });
  } catch (error) {
    console.error('Create table error:', error);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

// PUT /:id — rename a table.
router.put('/:id', (req: AuthRequest, res) => {
  try {
    const result = renameTable(req.userId!, req.params.id, req.body?.name);
    if ('fail' in result) return res.status(uiFailStatus(result)).json({ error: result.message });
    res.json(getTableForClient(req.params.id, req.userId!));
  } catch (error) {
    console.error('Update table error:', error);
    res.status(500).json({ error: 'Failed to update table' });
  }
});

// DELETE /:id — the service aborts active runs before the FK cascade wipes the
// rows, and drops the sheets' webhook rate buckets after.
router.delete('/:id', (req: AuthRequest, res) => {
  try {
    const result = deleteTable(req.userId!, req.params.id);
    if ('fail' in result) return res.status(uiFailStatus(result)).json({ error: result.message });
    res.json({ message: 'Table deleted successfully' });
  } catch (error) {
    console.error('Delete table error:', error);
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

export default router;
