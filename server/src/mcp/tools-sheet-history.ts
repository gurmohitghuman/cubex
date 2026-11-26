// get_sheet with history (tools-read.ts): the sheet's change log, newest first (services/sheet-history.ts, as
// GET /v1/sheets/:id/history), in place of its details. HISTORY_FIELDS are its fields, which only it takes.
import {
  CHANGE_LOG_DAYS, CHANGE_LOG_PAGE_DEFAULT, CHANGE_LOG_PAGE_MAX,
} from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { readSheetHistory } from '../services/sheet-history';
import { McpAuthCtx, err, lenientBoolean, lenientInt, ok, type ErrResult, type OkResult } from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';
import { z } from 'zod';

export const HISTORY_FIELDS = {
  history: lenientBoolean().optional()
    .describe(`true: the sheet's change log (${CHANGE_LOG_DAYS} days), newest first, in place of its details`),
  column: z.string().optional().describe('history: only lines about this column'),
  before: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('history: the next page, below this change id'),
  limit: lenientInt(1, CHANGE_LOG_PAGE_MAX).optional()
    .describe(`history: lines, 1-${CHANGE_LOG_PAGE_MAX} (default ${CHANGE_LOG_PAGE_DEFAULT})`),
};

export const HISTORY_WORDS = `history: true answers the sheet's change log instead (kept ${CHANGE_LOG_DAYS} days): `
  + 'what changed, when and by whom (the app, an access token by name, or Cubex itself).';

export function sheetHistoryAnswer(ctx: McpAuthCtx, sheetId: string, a: { column?: string; before?: number;
  limit?: number }): OkResult<ToolAnswer<'get_sheet'>> | ErrResult {
  if (!verifySheetOwnership(sheetId, ctx.userId)) return err('Sheet not found');
  return ok(readSheetHistory(sheetId, ctx.userId, a));
}
