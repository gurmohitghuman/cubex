// read_rows with format csv (tools-read.ts): the rows as CSV text in the answer, cut at MCP_EXPORT_MAX_CHARS
// (lib/csv-export.ts, as REST's export). It takes columns (names only), where and view; a file of any size is
// file_link's (action download).
import { db } from '../lib/db';
import { buildSheetCsv } from '../lib/csv-export';
import { MCP_EXPORT_MAX_CHARS } from '../lib/api-v1-constants';
import type { WhereItem } from '../lib/row-filter/where';
import { McpAuthCtx, ok, err, type ErrResult, type OkResult } from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';

export const CSV_WORDS = 'format csv answers the rows as CSV text (csv) instead, IN YOUR CONTEXT, so a wide or long '
  + 'sheet is EXPENSIVE: pass columns and where. It takes only columns, where, view and raw.';

interface Args { sheet_id: string; columns?: unknown[]; where?: unknown; view?: string; raw?: boolean }

export async function readRowsCsv(ctx: McpAuthCtx, a: Args, others: string[]):
  Promise<OkResult<ToolAnswer<'read_rows'>> | ErrResult> {
  if (others.length) return err(`format csv takes only columns, where, view and raw, not ${others.join(', ')}.`);
  if (a.columns?.some(c => typeof c !== 'string')) {
    return err('format csv takes column names only: read a value out of a JSON cell with format json.');
  }
  // As every read_rows answer, the sheet's versions: read first, so the CSV is at least as new as them.
  const versions = db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .get(a.sheet_id, ctx.userId) as { data_version: number; row_generation: number } | undefined;
  if (!versions) return err('Sheet not found');
  const result = await buildSheetCsv(a.sheet_id, ctx.userId, {
    columns: a.columns as string[] | undefined, where: a.where as WhereItem[] | undefined, view: a.view,
    maxChars: MCP_EXPORT_MAX_CHARS, raw: a.raw === true,
  });
  if ('fail' in result) {
    // A sheet with nothing in it yet is data, not a failure, as REST's export answers an empty 200.
    if (result.fail === 'empty') {
      return ok({ sheet_id: a.sheet_id, sheet_name: null, csv: '', row_count: 0, ...versions });
    }
    if (result.fail === 'invalid' || result.fail === 'busy') return err(result.error);
    return err('Sheet not found');
  }
  // rowCount comes from the builder (matched rows), not from counting lines: a quoted cell can hold a newline.
  const answer = {
    sheet_id: a.sheet_id, sheet_name: result.sheetName, csv: result.csv, row_count: result.rowCount,
    columns: result.columns, ...versions,
  };
  if (!result.truncated) return ok(answer);
  return ok({
    ...answer, matching_rows: result.matchingRows, truncated: true,
    rest: `Only the first ${result.rowCount} of ${result.matchingRows ?? 'the'} matching rows fit. `
      + 'Page through the rest with read_rows (same columns and where, format json), or save everything as a file '
      + 'with file_link (action download).',
  });
}
