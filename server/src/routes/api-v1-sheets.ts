// /v1 sheet reads: meta + paged rows. Rows are returned with their STABLE id —
// v1 writes address rows by id, never row_index (immune to physical sort /
// CSV-replace reindexing).
import express from 'express';
import { db } from '../lib/db';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { getSheetMeta, readRowsPage } from '../services/workspace-read';
import { API_V1_DEFAULT_ROWS_PAGE, API_V1_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import { parseRowQueryBody, queryRows } from '../services/row-selection';

const router = express.Router();

// GET /v1/sheets/:id — meta + ordered columns + row count. data_version is
// exposed so a client can cheaply detect "changed since I last looked".
router.get('/sheets/:id', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const meta = getSheetMeta(req.params.id, req.userId!);
    if (!meta) return res.status(404).json({ error: 'Sheet not found' });
    res.json(meta);
  } catch (error) {
    console.error('GET /v1/sheets/:id error:', error);
    res.status(500).json({ error: 'Failed to fetch sheet' });
  }
});

// GET /v1/sheets/:id/rows?limit&cursor — keyset-paged rows as {id, index, data}
// (services/workspace-read.ts, shared with the MCP read_rows tool).
router.get('/sheets/:id/rows', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(req.params.id, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isInteger(rawLimit)
      ? Math.max(1, Math.min(rawLimit, API_V1_MAX_ROWS_PAGE))
      : API_V1_DEFAULT_ROWS_PAGE;
    const rawCursor = parseInt(String(req.query.cursor ?? ''), 10);
    const after = Number.isInteger(rawCursor) && rawCursor >= 0 ? rawCursor : -1;

    res.json(readRowsPage(req.params.id, req.userId!, after, limit));
  } catch (error) {
    console.error('GET /v1/sheets/:id/rows error:', error);
    res.status(500).json({ error: 'Failed to fetch rows' });
  }
});

router.post('/sheets/:id/rows/query', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(req.params.id, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const parsed = parseRowQueryBody(req.body, API_V1_MAX_ROWS_PAGE);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const result = queryRows(req.params.id, req.userId!, parsed.query);
    if ('fail' in result) return res.status(result.fail === 'version_conflict' ? 409 : 400).json({ error: result.error });
    return res.json(result.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/rows/query error:', error);
    return res.status(500).json({ error: 'Failed to query rows' });
  }
});

export default router;
