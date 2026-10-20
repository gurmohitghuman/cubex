import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import {
  getSheetColumns, parseRowData, type RowDB,
} from '../lib/sql-helpers';
import { sheetColumnKinds } from '../lib/column-types';
import { FILL_PLACEHOLDER, fillingColumns } from '../services/answer-field-fill';
import { sheetCleanView } from '../services/clean-view';
import { sheetFormulaView } from '../services/formula-view';
import { sheetLookupView } from '../services/lookup-view';
import { enrichColumnSpend, sheetAutorunView } from '../services/autorun-view';
import { scheduleColumnRepair } from '../lib/column-repair';
import { liveRunColumns, savedFilterSql, withStale } from '../services/row-filter';
import { scanFiltered } from '../lib/filtered-scan';
import { listViews } from '../services/view-store';
import { sheetColumnDescriptions } from '../lib/column-descriptions';
import { type SheetRow, normalizeColumnName } from './sheets-shared';
import { waterfallColumnSpend } from '../services/waterfall-status';
import { autoDedupeView } from '../services/auto-dedupe-setting';
import { isSampleSheet } from '../services/sample-table';
import { aiVisibilityForSheet, aiVisibilityView } from '../services/ai-visibility-run';

const aiVisibilityOfSheet = (sheetId: string, userId: string) => {
  const rec = aiVisibilityForSheet(userId, sheetId);
  return rec ? aiVisibilityView(rec) : null;
};
const RUN_MAIN_TYPES = new Set<string | undefined>(['ai-output', 'http-master', 'enrich-status', 'waterfall']);

const router = express.Router();
router.use(authenticateToken);

// GET /:id — paginated sheet data. `limit` and `offset` are in ROWS.
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const sheet = db.prepare('SELECT * FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
      .get(id, req.userId!) as SheetRow | undefined;
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // The column registry (lib/sheet-columns.ts): no row scan on this hot path.
    // Opening a sheet also queues its once-per-process background check for
    // values stored under unlisted columns (lib/column-repair.ts).
    const columns = getSheetColumns(id, req.userId!);
    if (offset === 0) scheduleColumnRepair(id, req.userId!);

    // Authoritative per-column type (AI / HTTP), derived from the run records that
    // created the columns — NOT guessed from cell contents or names. The grid's
    // header menu keys off this to decide whether to show AI vs HTTP actions.
    // Columns absent from this map are plain. See lib/column-types.ts.
    const kinds = sheetColumnKinds(id, req.userId!);
    const columnTypes = kinds.types;

    // The saved column filters (sheets.empty_filter, column_filters, row_filter:
    // the active view's) are
    // applied SERVER-SIDE so the page, totalRows, and pagination all reflect the
    // filtered set: the grid is windowed, so filtering only the loaded rows left
    // matches beyond them invisible AND unreachable. A row passes only if it
    // matches EVERY column's filter (services/row-filter.ts, the same SQL the
    // API's `where` uses); the page and count queries below share the clause.
    const saved = savedFilterSql(id, req.userId!, sheet,
      () => withStale(liveRunColumns(kinds.runState, columns), id, req.userId!, columns));
    // Saved views (the view menu, the active one's hidden columns), read with
    // the sheet row above, before the scan yields: a view switched meanwhile
    // can't pair one view's filters with another's id.
    const views = listViews(id, req.userId!, columns) ?? [];

    // Paginated read in row_index order: sort is a one-time physical reorder,
    // so row_index order IS the display order. Unfiltered, the page and the
    // count come from the index. Filtered, finding the page and counting the
    // matches is a scan of every row, done a slice at a time between other
    // requests (lib/filtered-scan.ts) so a big sheet never holds the server.
    let dbRows: Array<Pick<RowDB, 'row_index' | 'data'>>, totalRows: number;
    if (saved) {
      const scan = await scanFiltered<Pick<RowDB, 'row_index' | 'data'>>(
        id, req.userId!, saved, { skip: offset, limit, count: true }, 'row_index, data');
      dbRows = scan.rows;
      totalRows = scan.count!;
    } else {
      dbRows = db.prepare(
        'SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index ASC LIMIT ? OFFSET ?',
      ).all(id, req.userId!, limit, offset) as RowDB[];
      totalRows = (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?')
        .get(id, req.userId!) as { c: number }).c;
    }
    const rows = dbRows.map(r => ({ rowIndex: r.row_index, data: parseRowData(r.data) }));
    // A column added from stored answers, or a clean column, shows ⏳ until its
    // fill is done (services/answer-field-fill.ts, clean-fill.ts), then the tab
    // reloads into its values.
    const filling = fillingColumns(id, req.userId!).filter(c => columns.includes(c));
    for (const r of filling.length ? rows : []) for (const c of filling) r.data[c] = FILL_PLACEHOLDER;

    // Strip internal-only columns from the sheet before it goes to the client.
    // `sheet` was SELECT *'d for the server-side filter reads above; the
    // response must not carry user_id or column_order (client never reads them —
    // internal-schema exposure flagged in a security review).
    const { user_id: _uid, column_order: _co, ...sheetForClient } =
      sheet as unknown as Record<string, unknown>;
    // Auto-run per column and what each enrichment column spent: the headers' ⚡
    // and tooltips, and the sheet header's auto-run chip.
    const autorun = sheetAutorunView(id, req.userId!);
    const columnSpend = {
      ...enrichColumnSpend(id, req.userId!, Object.keys(columnTypes).filter(c => columnTypes[c] === 'enrich-status')),
      ...waterfallColumnSpend(id, req.userId!, Object.keys(columnTypes).filter(c => columnTypes[c] === 'waterfall')),
    };
    // Clean data columns' setups: the column menu and the Edit cleaning dialog.
    const cleanColumns = sheetCleanView(id, req.userId!, columns);
    // Formula columns' setups: the header tip, the column menu and the Edit formula dialog.
    const formulaColumns = sheetFormulaView(id, req.userId!, columns);
    // Lookup columns' setups: the header tip, the column menu and the Edit lookup dialog.
    const lookupColumns = sheetLookupView(id, req.userId!, columns);
    // Column descriptions: the header tip and the column menu's Edit description.
    const columnDescriptions = Object.fromEntries(
      [...sheetColumnDescriptions(id, req.userId!)].filter(([c]) => columns.includes(c)));
    // Each column an AI, HTTP API, enrichment or waterfall run fills → its main
    // column: a cell's play button runs that run's row, hidden while it runs.
    const runColumns = Object.fromEntries([...liveRunColumns(kinds.runState, columns)]
      .filter(([, main]) => RUN_MAIN_TYPES.has(columnTypes[main])));
    res.json({
      sheet: sheetForClient,
      data: {
        rows, columns, totalRows, columnTypes, autorun, columnSpend, cleanColumns, formulaColumns, lookupColumns, views,
        columnDescriptions, runColumns,
        // Auto-dedupe's setting (services/auto-dedupe-setting.ts): the toolbar shows it's on.
        autoDedupe: autoDedupeView(id, req.userId!),
        // The sample sheet (services/sample-table.ts) shows its guide above the grid.
        sample: isSampleSheet(id, req.userId!),
        // An AI visibility table's questions sheet shows its guide (services/ai-visibility-*.ts).
        aiVisibility: aiVisibilityOfSheet(id, req.userId!),
      },
    });
  } catch (error) {
    console.error('Get sheet error:', error);
    res.status(500).json({ error: 'Failed to fetch sheet data' });
  }
});

// GET /:id/columns — column suggestion list for the AI/HTTP '/' picker.
// Uses getSheetColumns, which returns column_order filtered against the keys that
// actually exist in rows.data (ghosts dropped) and cached per data-version. This
// is exactly the ghost-filtering this handler used to do by hand with a fresh
// json_each scan on every call — same result, but a cache hit (microseconds)
// whenever the sheet was opened and not written since, instead of a ~1.3s scan
// on a 50k-row sheet every time the modal opens.
router.get('/:id/columns', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const sheet = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
      .get(id, req.userId!) as { id: string } | undefined;
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    const columns = getSheetColumns(id, req.userId!);
    res.json(columns.map(col => ({ name: col, reference: `/${normalizeColumnName(col)}` })));
  } catch (error) {
    console.error('Get columns error:', error);
    res.status(500).json({ error: 'Failed to fetch columns' });
  }
});

export default router;
