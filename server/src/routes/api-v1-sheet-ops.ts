// /v1 sheet operations: physical sort + CSV export. Both delegate to the
// implementations shared with the UI routes (services/sheet-sort.ts,
// lib/csv-export.ts).
import express from 'express';
import { db } from '../lib/db';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { physicalSortSheet } from '../services/sheet-sort';
import { streamSheetCsv } from '../lib/csv-export';

const router = express.Router();

function ownsSheet(sheetId: string, userId: string): boolean {
  return !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);
}

// POST /v1/sheets/:id/sort {column, direction} — one-time PHYSICAL reorder
// (Google Sheets semantics; there is no live sort view).
// Bumps row_generation (inside the service txn) AND data_version (v1 rule:
// open tabs must learn their row indices are stale).
router.post('/sheets/:id/sort', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    if (!ownsSheet(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const { column, direction } = req.body as { column?: unknown; direction?: unknown };
    if (typeof column !== 'string' || !column) {
      return res.status(400).json({ error: 'column is required (string)' });
    }
    if (direction !== 'asc' && direction !== 'desc') {
      return res.status(400).json({ error: "direction must be 'asc' or 'desc'" });
    }

    const result = await physicalSortSheet(req.params.id, req.userId!, column, direction, { bumpDataVersion: true });
    if ('fail' in result) {
      if (result.fail === 'busy') return res.status(409).json({ error: result.error });
      if (result.fail === 'column_not_found') {
        return res.status(404).json({ error: `Column "${column}" not found in this sheet` });
      }
      return res.status(409).json({
        error: 'Cannot sort while a run is active on this sheet. Stop or finish the run first.',
      });
    }
    res.json({ rows_reordered: result.rowsReordered });
  } catch (error) {
    console.error('POST /v1/sheets/:id/sort error:', error);
    res.status(500).json({ error: 'Failed to sort sheet' });
  }
});

// GET /v1/sheets/:id/export — text/csv download (formula-injection-escaped).
// An empty sheet exports as an empty 200 body rather than the UI's 400 — an
// agent script treats "nothing there yet" as data, not an error.
router.get('/sheets/:id/export', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const result = await streamSheetCsv(req.params.id, req.userId!, res);
    if (result === 'not_found') return res.status(404).json({ error: 'Sheet not found' });
    if (result === 'empty') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send('');
    }
    if (typeof result === 'object') return res.status(409).json({ error: result.busy, busy: true });
  } catch (error) {
    console.error('GET /v1/sheets/:id/export error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export CSV' });
    else res.destroy();
  }
});

export default router;
