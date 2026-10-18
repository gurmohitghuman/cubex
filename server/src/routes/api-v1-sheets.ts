// /v1 sheet reads: meta + paged rows. Rows are returned with their STABLE id —
// v1 writes address rows by id, never row_index (immune to physical sort /
// CSV-replace reindexing).
import { verifySheetOwnership } from '../lib/sql-helpers';
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { readRowsPage } from '../services/workspace-read';
import { readSheetDetails } from '../services/sheet-details';
import { watchGone } from '../lib/request-gone';
import { API_V1_DEFAULT_ROWS_PAGE, API_V1_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import { parseRowQueryBody, queryRows } from '../services/row-selection';

const router = express.Router();

// GET /v1/sheets/:id — meta + ordered columns + row count + column details
// (services/sheet-details.ts, shared with MCP get_sheet). data_version is
// exposed so a client can cheaply detect "changed since I last looked".
// ?columns=A&columns=B shows those in full; include_counts=true counts rows.
router.get('/sheets/:id', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const counts = String(req.query.include_counts ?? '');
    if (counts !== '' && counts !== 'true' && counts !== 'false') {
      return res.status(400).json({ error: 'include_counts must be true or false.' });
    }
    const raw = req.query.columns;
    const columns = raw === undefined ? undefined : (Array.isArray(raw) ? raw : [raw]).map(String);
    const read = await readSheetDetails(req.params.id, req.userId!,
      { columns, counts: counts === 'true', stop: watchGone(res) });
    if (!read) return res.status(404).json({ error: 'Sheet not found' });
    if ('error' in read) return res.status(400).json({ error: read.error });
    res.json(read.ok);
  } catch (error) {
    console.error('GET /v1/sheets/:id error:', error);
    res.status(500).json({ error: 'Failed to fetch sheet' });
  }
});

// GET /v1/sheets/:id/rows?limit&cursor&include_status — keyset-paged rows as
// {id, index, data} (services/workspace-read.ts, shared with the MCP read_rows
// tool). include_status=true: run columns' cells as {status, value, error}.
router.get('/sheets/:id/rows', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    if (!verifySheetOwnership(req.params.id, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isInteger(rawLimit)
      ? Math.max(1, Math.min(rawLimit, API_V1_MAX_ROWS_PAGE))
      : API_V1_DEFAULT_ROWS_PAGE;
    const rawCursor = parseInt(String(req.query.cursor ?? ''), 10);
    const after = Number.isInteger(rawCursor) && rawCursor >= 0 ? rawCursor : -1;

    const status = String(req.query.include_status ?? '');
    if (status !== '' && status !== 'true' && status !== 'false') {
      return res.status(400).json({ error: 'include_status must be true or false.' });
    }
    res.json(readRowsPage(req.params.id, req.userId!, after, limit, status === 'true'));
  } catch (error) {
    console.error('GET /v1/sheets/:id/rows error:', error);
    res.status(500).json({ error: 'Failed to fetch rows' });
  }
});

router.post('/sheets/:id/rows/query', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    if (!verifySheetOwnership(req.params.id, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const parsed = parseRowQueryBody(req.body, API_V1_MAX_ROWS_PAGE);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const result = await queryRows(req.params.id, req.userId!, parsed.query);
    if ('fail' in result) {
      return res.status(result.fail === 'invalid' ? 400 : 409)
        .json({ error: result.error, ...(result.fail === 'busy' ? { busy: true } : {}) });
    }
    return res.json(result.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/rows/query error:', error);
    return res.status(500).json({ error: 'Failed to query rows' });
  }
});

export default router;
