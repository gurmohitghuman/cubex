import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import {
  getSheetColumns, parseRowData, type RowDB,
} from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import { scheduleColumnRepair } from '../lib/column-repair';
import { parseEmptyFilter, buildEmptyFilterSql } from '../lib/empty-filter';
import { parseColumnFilters, buildColumnFiltersSql } from '../lib/column-filters';
import { type SheetRow, normalizeColumnName } from './sheets-shared';

const router = express.Router();
router.use(authenticateToken);

// GET /:id — paginated sheet data. `limit` and `offset` are in ROWS.
router.get('/:id', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const sheet = db.prepare('SELECT * FROM sheets WHERE id = ? AND user_id = ?')
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
    const columnTypes = getColumnTypes(id, req.userId!);

    // Empty-filter is applied SERVER-SIDE so the page, totalRows, and pagination
    // all reflect the filtered set. Previously the client filtered only the loaded
    // window, so matches beyond it were invisible AND unreachable (the scroll
    // trigger can't fire with few/zero visible rows). The filter is stored on the
    // sheet (sheets.empty_filter); read it here rather than trust a query param.
    const emptyFilter = parseEmptyFilter(sheet.empty_filter);
    const emptySql = buildEmptyFilterSql(emptyFilter);
    // "Text contains" filter (migration 031) — AND-joined with the empty filter
    // in the SAME clause (Google-Sheets semantics: a row passes only if it
    // matches EVERY active column filter). Both are server-side for the same
    // windowed-grid reason. Concatenating the two ' AND ...' fragments + params
    // keeps the page and count queries below in step.
    const columnFilters = parseColumnFilters(sheet.column_filters);
    const containsSql = buildColumnFiltersSql(columnFilters);
    const filterClause = emptySql.clause + containsSql.clause;
    const filterParams = [...emptySql.params, ...containsSql.params];

    // Indexed paginated read in row_index order: sort is a one-time physical
    // reorder, so row_index order IS the display order. Filter predicates (if
    // any) go into BOTH the page query and the count so totalRows matches.
    const dbRows = db.prepare(
      `SELECT * FROM rows WHERE sheet_id = ? AND user_id = ?${filterClause} ORDER BY row_index ASC LIMIT ? OFFSET ?`,
    ).all(id, req.userId!, ...filterParams, limit, offset) as RowDB[];
    const totalRows = (db.prepare(
      `SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?${filterClause}`,
    ).get(id, req.userId!, ...filterParams) as { c: number }).c;
    const rows = dbRows.map(r => ({ rowIndex: r.row_index, data: parseRowData(r.data) }));

    // Strip internal-only columns from the sheet before it goes to the client.
    // `sheet` was SELECT *'d for the server-side filter reads above; the
    // response must not carry user_id or column_order (client never reads them —
    // internal-schema exposure flagged in a security review).
    const { user_id: _uid, column_order: _co, ...sheetForClient } =
      sheet as unknown as Record<string, unknown>;
    res.json({ sheet: sheetForClient, data: { rows, columns, totalRows, columnTypes } });
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
    const sheet = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?')
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
