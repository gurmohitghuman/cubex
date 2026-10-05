import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { transferRows, TransferRequest } from '../services/rows-transfer';
import { parseRowQueryBody } from '../services/row-selection';
import { TransferSelection } from '../services/transfer-selection';

const router = express.Router();

function parseSelection(value: unknown): TransferSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const choices = [v.all === true, Array.isArray(v.row_ids), Array.isArray(v.where)].filter(Boolean).length;
  if (choices !== 1) return null;
  if (v.all === true) return { all: true };
  if (Array.isArray(v.row_ids) && v.row_ids.length > 0 && v.row_ids.length <= MAX_ROWS_PER_SHEET
      && v.row_ids.every(id => typeof id === 'string')) return { row_ids: v.row_ids as string[] };
  if (Array.isArray(v.where) && v.where.length > 0) {
    const parsed = parseRowQueryBody({ where: v.where }, MAX_ROWS_PER_SHEET);
    if ('query' in parsed) return { where: parsed.query.where! };
  }
  return null;
}

router.post('/sheets/:sourceId/rows/transfer', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const key = req.get('Idempotency-Key');
    const selection = parseSelection(body.selection);
    if (!key || !selection || !['copy', 'move'].includes(String(body.operation))) {
      return res.status(400).json({ error: 'Idempotency-Key, operation, and exactly one valid selection are required.' });
    }
    if (typeof body.destination_sheet_id !== 'string') {
      return res.status(400).json({ error: 'destination_sheet_id is required.' });
    }
    const mode = body.column_mode ?? 'create_missing';
    if (!['require_existing', 'create_missing'].includes(String(mode))) {
      return res.status(400).json({ error: 'Invalid column_mode.' });
    }
    if (body.columns !== undefined && (!Array.isArray(body.columns) || body.columns.length === 0
        || body.columns.some(c => typeof c !== 'string'))) {
      return res.status(400).json({ error: 'columns must be a non-empty string array.' });
    }
    if (body.column_mapping !== undefined
        && (!body.column_mapping || typeof body.column_mapping !== 'object' || Array.isArray(body.column_mapping)
          || Object.entries(body.column_mapping).some(([source, destination]) => !source || typeof destination !== 'string'))) {
      return res.status(400).json({ error: 'column_mapping must be an object.' });
    }
    const request: TransferRequest = {
      sourceSheetId: req.params.sourceId,
      destinationSheetId: body.destination_sheet_id,
      operation: body.operation as 'copy' | 'move',
      selection,
      columns: body.columns as string[] | undefined,
      columnMode: mode as 'require_existing' | 'create_missing',
      columnModeOmitted: body.column_mode === undefined,
      columnMapping: (body.column_mapping as Record<string, string>) ?? {},
      idempotencyKey: key,
    };
    const result = transferRows(req.userId!, request);
    if ('fail' in result) {
      const status = result.fail === 'not_found' ? 404
        : ['conflict', 'active_run', 'active'].includes(result.fail) ? 409
        : result.fail === 'rate' ? 429 : 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json({ ...result.ok, replayed: result.replayed ?? false });
  } catch (error) {
    console.error('POST /v1/sheets/:sourceId/rows/transfer error:', error);
    return res.status(500).json({ error: 'Failed to transfer rows' });
  }
});

export default router;
