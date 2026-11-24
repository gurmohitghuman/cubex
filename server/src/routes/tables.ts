import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { listSheets, getSheetForClient, getTableForClient } from '../lib/sheet-crud-helpers';
import { sheetListKey } from '../lib/sheet-list-key';
import { getTrashDays } from '../lib/trash/store';
import {
  createTable, renameTable, deleteTable, type TableCrudFail,
} from '../services/table-crud';
import { createSampleTable } from '../services/sample-table';
import { homeCounts, homeCountsWhenMade, liveSheets } from '../services/table-row-counts';
import { acquireCountWait } from '../lib/long-poll-holds';

const router = express.Router();
router.use(authenticateToken);

// GET /: the user's tables with their sheet ids and rows, counted nothing on the request (lib/row-counts.ts): a
// table whose rows changed since they were last counted answers that count with row_count_updating, and the home
// then waits for the new one (GET /row-counts).
router.get('/', (req: AuthRequest, res) => {
  try {
    // Explicit client columns (no user_id) — this row is spread into the response
    // below, so `SELECT *` would leak the internal user_id.
    const tables = db.prepare(
      `SELECT id, name, created_at, updated_at FROM tables WHERE user_id = ? AND trash_id IS NULL
       ORDER BY created_at DESC`,
    ).all(req.userId!) as Array<{ id: string; name: string; created_at: string; updated_at: string }>;
    const sheets = liveSheets(req.userId!);
    const counts = homeCounts(req.userId!, sheets);
    const sheetsByTable = new Map<string, Array<{ id: string }>>();
    for (const s of sheets) {
      if (!sheetsByTable.has(s.table_id)) sheetsByTable.set(s.table_id, []);
      sheetsByTable.get(s.table_id)!.push({ id: s.id });
    }
    res.json(tables.map(t => ({
      ...t, sheets: sheetsByTable.get(t.id) || [],
      row_count: counts.get(t.id)?.row_count ?? 0, row_count_updating: counts.get(t.id)?.row_count_updating ?? false,
    })));
  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

// GET /row-counts: every table's rows once the counts the home showed as updating are made (held up to
// ROW_COUNT_HOLD_MS; one still being counted then answers row_count_updating and the home asks again). 429 when the
// account already holds MAX_COUNT_WAITS_PER_USER of these: the home keeps its counts marked as updating. A page that
// leaves lets go of its slot at once (the response closes), as the sheet's change poll does.
router.get('/row-counts', async (req: AuthRequest, res) => {
  const release = acquireCountWait(req.userId!);
  if (!release) {
    return res.status(429).json({ error: 'Too many home pages are open. Close one, then reload this page.' });
  }
  res.on('close', release);
  try {
    res.json({ tables: await homeCountsWhenMade(req.userId!) });
  } catch (error) {
    console.error('Get row counts error:', error);
    res.status(500).json({ error: 'Couldn\'t count the rows. Reload the page to try again.' });
  } finally {
    release();
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

// POST /sample — a new table of made-up leads with the columns that show what
// Cubex does (services/sample-table.ts). Answers like POST /, plus the sheet to open.
router.post('/sample', async (req: AuthRequest, res) => {
  try {
    const result = await createSampleTable(req.userId!);
    if ('fail' in result) return res.status(400).json({ error: result.message });
    const table = getTableForClient(result.ok.tableId, req.userId!);
    const sheet = getSheetForClient(result.ok.sheetId, req.userId!);
    res.json({ ...(table as object), sheets: [sheet], sheetId: result.ok.sheetId, problems: result.ok.problems });
  } catch (error) {
    console.error('Create sample table error:', error);
    res.status(500).json({ error: 'Failed to create the sample table' });
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

// DELETE /:id — into the trash with its sheets (services/trash-sheets.ts).
router.delete('/:id', (req: AuthRequest, res) => {
  try {
    const result = deleteTable(req.userId!, req.params.id);
    if ('fail' in result) return res.status(uiFailStatus(result)).json({ error: result.message });
    res.json({
      message: 'Table deleted successfully',
      trash: result.ok.trashId === null ? null : { id: result.ok.trashId, days: getTrashDays(req.userId!) },
    });
  } catch (error) {
    console.error('Delete table error:', error);
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

export default router;
