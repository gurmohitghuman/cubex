// HTTP-shaped helpers for the /api/v1 sub-routers. The underlying data-plane
// logic lives in services/data-plane-shared.ts (shared with the MCP tools);
// this module only maps TxnFail outcomes onto Express responses.
import express from 'express';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { TxnFail, txnFailMessage } from '../services/data-plane-shared';

export { parseCellMap } from '../services/data-plane-shared';

export function failResponse(res: express.Response, f: TxnFail) {
  const status =
    f.fail === 'locked' || f.fail === 'active_run' || f.fail === 'protected_columns' || f.fail === 'busy' ? 409
    : f.fail === 'not_found' ? 404
    : 400;
  const body: Record<string, unknown> = { error: txnFailMessage(f, MAX_ROWS_PER_SHEET) };
  if (f.fail === 'unknown_columns') body.unknownColumns = f.columns;
  if (f.fail === 'locked') body.lockedColumns = f.columns;
  if (f.fail === 'protected_columns') body.protectedColumns = f.columns;
  if (f.fail === 'busy') body.busy = true;
  return res.status(status).json(body);
}
