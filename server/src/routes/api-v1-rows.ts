// /v1 row mutations — thin HTTP wrappers over services/rows-write.ts (shared
// with the MCP tools). Semantics live there.
import express from 'express';
import { db } from '../lib/db';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { parseCellMap, failResponse } from './api-v1-shared';
import { appendRows, patchRowById, deleteRowsByIds } from '../services/rows-write';
import {
  API_V1_MAX_APPEND_ROWS, API_V1_MAX_BATCH_UPDATES, API_V1_MAX_DELETE_ROWS, API_V1_MAX_PATCH_CELLS,
} from '../lib/api-v1-constants';
import { batchUpdateRows } from '../services/rows-batch-update';

const router = express.Router();

function ownsSheet(sheetId: string, userId: string): boolean {
  return !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);
}

// POST /v1/sheets/:id/rows — append a batch. Body: { rows: [{data: {col: val}}] }.
router.post('/sheets/:id/rows', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const sheetId = req.params.id;
    if (!ownsSheet(sheetId, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });

    const rawRows = (req.body as { rows?: unknown }).rows;
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return res.status(400).json({ error: 'rows must be a non-empty array of {data: {columnName: value}}' });
    }
    if (rawRows.length > API_V1_MAX_APPEND_ROWS) {
      return res.status(400).json({ error: `Cannot append more than ${API_V1_MAX_APPEND_ROWS} rows per call.` });
    }
    const parsedRows: Array<Record<string, string>> = [];
    for (const entry of rawRows) {
      const p = parseCellMap((entry as { data?: unknown })?.data, API_V1_MAX_PATCH_CELLS);
      if ('error' in p) return res.status(400).json({ error: p.error });
      parsedRows.push(p.cells);
    }

    const result = appendRows(sheetId, req.userId!, parsedRows);
    if ('fail' in result) return failResponse(res, result);
    res.status(201).json(result.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/rows error:', error);
    res.status(500).json({ error: 'Failed to append rows' });
  }
});

// PATCH /v1/rows/:rowId — update cells on ONE row by stable id.
// Body: { data: {col: val|null} }; null clears to ''.
router.patch('/rows/:rowId', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const p = parseCellMap((req.body as { data?: unknown })?.data, API_V1_MAX_PATCH_CELLS);
    if ('error' in p) return res.status(400).json({ error: p.error });

    const result = patchRowById(req.params.rowId, req.userId!, p.cells);
    if ('fail' in result) {
      if (result.fail === 'not_found') return res.status(404).json({ error: 'Row not found' });
      return failResponse(res, result);
    }
    res.json(result.ok);
  } catch (error) {
    console.error('PATCH /v1/rows/:rowId error:', error);
    res.status(500).json({ error: 'Failed to update row' });
  }
});

router.post('/sheets/:id/rows/update', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const sheetId = req.params.id;
    if (!ownsSheet(sheetId, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const updates = (req.body as { updates?: unknown }).updates;
    if (!Array.isArray(updates) || updates.length < 1 || updates.length > API_V1_MAX_BATCH_UPDATES) {
      return res.status(400).json({ error: `updates must contain 1-${API_V1_MAX_BATCH_UPDATES} entries` });
    }
    const parsed = [];
    for (const update of updates) {
      if (!update || typeof update !== 'object' || typeof update.row_id !== 'string') {
        return res.status(400).json({ error: 'Every update requires a row_id and data object' });
      }
      const cells = parseCellMap(update.data, API_V1_MAX_PATCH_CELLS);
      if ('error' in cells) return res.status(400).json({ error: cells.error });
      parsed.push({ rowId: update.row_id, cells: cells.cells });
    }
    const result = batchUpdateRows(sheetId, req.userId!, parsed);
    if ('fail' in result) {
      if (result.fail === 'duplicate_rows') return res.status(400).json({ error: 'updates must not contain duplicate row ids' });
      if (result.fail === 'not_found') return res.status(404).json({ error: 'One or more rows were not found in the supplied sheet.' });
      return failResponse(res, result);
    }
    return res.json(result.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/rows/update error:', error);
    return res.status(500).json({ error: 'Failed to update rows' });
  }
});

// POST /v1/sheets/:id/rows/delete — bulk delete by stable row ids.
router.post('/sheets/:id/rows/delete', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const sheetId = req.params.id;
    if (!ownsSheet(sheetId, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const rawIds = (req.body as { row_ids?: unknown }).row_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some(x => typeof x !== 'string')) {
      return res.status(400).json({ error: 'row_ids must be a non-empty array of row id strings' });
    }
    if (rawIds.length > API_V1_MAX_DELETE_ROWS) {
      return res.status(400).json({ error: `Cannot delete more than ${API_V1_MAX_DELETE_ROWS} rows per call.` });
    }

    const result = deleteRowsByIds(sheetId, req.userId!, rawIds as string[]);
    if ('fail' in result) return failResponse(res, result);
    res.json(result.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/rows/delete error:', error);
    res.status(500).json({ error: 'Failed to delete rows' });
  }
});

export default router;
