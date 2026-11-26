import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import {
  listSheets, getSheetForClient, getTableForClient, listTablesForClient, listTestSheets,
} from '../lib/sheet-crud-helpers';
import { sheetListKey } from '../lib/sheet-list-key';
import { getTrashDays } from '../lib/trash/store';
import {
  createTable, renameTable, deleteTable, markTableOpened, setTableStarred, type TableCrudFail,
} from '../services/table-crud';
import { createSampleTable } from '../services/sample-table';
import { homeCounts, homeCountsWhenMade, liveSheets } from '../services/table-row-counts';
import { homeRuns, homeRunsWhenChanged } from '../services/table-runs';
import { acquireCountWait, acquireRunsWait } from '../lib/long-poll-holds';
import { ROW_COUNT_HOLD_MS } from '../lib/constants-row-counts';

const router = express.Router();
router.use(authenticateToken);

// GET /: the user's tables with their sheet ids and rows, counted nothing on the request (lib/row-counts.ts): a
// table whose rows changed since they were last counted answers that count with row_count_updating, and the home
// then waits for the new one (GET /row-counts). runs: its runs going now and paused (services/table-runs.ts), left
// out when it has none; the home then follows them (GET /runs). starred and last_opened_at: the home's Favorites
// and Recent tabs (migration 064).
router.get('/', (req: AuthRequest, res) => {
  try {
    // Explicit client columns (no user_id): each row is spread into the response below.
    const tables = listTablesForClient(req.userId!);
    const sheets = liveSheets(req.userId!);
    const counts = homeCounts(req.userId!, sheets);
    const runs = homeRuns(req.userId!, sheets);
    const sheetsByTable = new Map<string, Array<{ id: string }>>();
    for (const s of sheets) {
      if (!sheetsByTable.has(s.table_id)) sheetsByTable.set(s.table_id, []);
      sheetsByTable.get(s.table_id)!.push({ id: s.id });
    }
    res.json(tables.map(t => ({
      ...t, sheets: sheetsByTable.get(t.id) || [],
      row_count: counts.get(t.id)?.row_count ?? 0, row_count_updating: counts.get(t.id)?.row_count_updating ?? false,
      ...(runs.has(t.id) ? { runs: runs.get(t.id) } : {}),
    })));
  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

// GET /row-counts: every table's rows once the counts the home showed as updating are made (held up to
// ROW_COUNT_HOLD_MS; one still being counted then answers row_count_updating and the home asks again). 429 when the
// account already holds MAX_COUNT_WAITS_PER_USER of these (other tabs of the home), with Retry-After: the hold's
// length, by when one of them has answered. A page that leaves lets go of its slot at once (the response closes),
// as the sheet's change poll does.
router.get('/row-counts', async (req: AuthRequest, res) => {
  const release = acquireCountWait(req.userId!);
  if (!release) {
    res.set('Retry-After', String(Math.ceil(ROW_COUNT_HOLD_MS / 1000)));
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

// GET /runs?since=<key>: every table's runs going now and paused once they differ from `since` (the key the last
// answer gave; none: answers at once), checked once a second and held up to RUNS_HOLD_MS. 429 with Retry-After when
// the account already holds MAX_RUNS_WAITS_PER_USER of these (other tabs of the home). Leaving lets go at once.
const RUNS_HOLD_MS = 25_000;
const RUNS_CHECK_MS = 1_000;
router.get('/runs', async (req: AuthRequest, res) => {
  const release = acquireRunsWait(req.userId!);
  if (!release) {
    res.set('Retry-After', String(RUNS_HOLD_MS / 1000));
    return res.status(429).json({ error: 'Too many home pages are open. Close one, then reload this page.' });
  }
  let closed = false;
  res.on('close', () => { closed = true; release(); });
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  try {
    const runs = await homeRunsWhenChanged(req.userId!, since, Date.now() + RUNS_HOLD_MS, RUNS_CHECK_MS, () => closed);
    if (!closed) res.json(runs);
  } catch (error) {
    console.error('Get runs error:', error);
    if (!closed) res.status(500).json({ error: 'Couldn\'t read the runs. Reload the page to try again.' });
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
    // sheets_key seeds the sheet change-poll's tab-list check (lib/sheet-list-key.ts). test_sheets: copies of its
    // sheets where column changes are being tried (services/sheet-test-*.ts), opened by id, never shown as tabs.
    res.json({ ...(table as object), sheets, test_sheets: listTestSheets(id, req.userId!),
      sheets_key: sheetListKey(id, req.userId!) });
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

// PUT /:id/starred {starred}: the home's star (Favorites lists the starred tables). Answers the table.
router.put('/:id/starred', (req: AuthRequest, res) => {
  try {
    const result = setTableStarred(req.userId!, req.params.id, req.body?.starred);
    if ('fail' in result) return res.status(uiFailStatus(result)).json({ error: result.message });
    res.json(getTableForClient(req.params.id, req.userId!));
  } catch (error) {
    console.error('Star table error:', error);
    res.status(500).json({ error: 'Couldn\'t star the table. Try again.' });
  }
});

// POST /:id/opened: the table page says the user opened the table (once its first rows show), and the home's Recent
// tab lists it first. Answers at once; the time is written when the write lock is free (lib/table-opened.ts). The
// app's own call, never /v1 or MCP.
router.post('/:id/opened', (req: AuthRequest, res) => {
  try {
    if (!markTableOpened(req.userId!, req.params.id)) return res.status(404).json({ error: 'Table not found' });
    res.status(204).end();
  } catch (error) {
    console.error('Mark table opened error:', error);
    res.status(500).json({ error: 'Couldn\'t note that the table was opened.' });
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
