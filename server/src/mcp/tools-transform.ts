import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { transformColumn, TransformParams } from '../services/column-transform';
import { TransformOp } from '../lib/transform-ops';
import { TRANSFORM_MAX_CALL_MS, TRANSFORM_MAX_ROWS } from '../lib/api-v1-constants';
import { SHEET_ID, McpAuthCtx, ok, err, errWith, missingScope, registerTool } from './tool-helpers';
import { whereLike } from './where-schema';
import { changedOf } from './changed';

export function registerTransformTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'transform_column', {
    description:
      'Fill target_column from other columns with a fixed rule, on the server: no AI, no cost. Use it rather '
      + 'than run_ai_column for mechanical text work; for names, company names, emails, domains, phones, Title '
      + 'Case and spaces use clean_column (it keeps cleaning new rows); for a live per-row result use '
      + 'formula_column. Example: turn "8 | B2B SaaS" into a number with regex_extract pattern "^(\\\\d+)". '
      + `A call writes at most ${TRANSFORM_MAX_ROWS.toLocaleString('en-US')} rows or works about `
      + `${TRANSFORM_MAX_CALL_MS / 1000} seconds, and the rows it wrote stay written. With rows left it answers `
      + 'next_cursor: call again with the same arguments and that cursor. An error after some rows carries '
      + 'next_cursor and rows_done: go on with that cursor, never start over (those rows would get the operation '
      + 'twice). While a pass is unfinished, a call on the same column without its cursor is refused with the '
      + 'cursor; restart:true starts over instead. If the pass\'s rows move (a sort, an import undone, duplicates '
      + 'removed, rows restored to other places), every call into its column is refused until restart: true, '
      + 'unless it had done no rows. A pass ends at the last row, on restart or when its column is permanently '
      + 'deleted. Returns updated (rows written), created_column and, with rows left, next_cursor. '
      + 'Next: read_rows to check the column.',
    inputSchema: {
      sheet_id: z.string().describe(SHEET_ID),
      target_column: z.string().describe('Column to write into; created if it does not exist'),
      operation: z.enum(['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number'])
        .describe('regex_extract: group 1 of pattern; split: part index of source split by pattern; template: '
          + 'from any columns; upper, lower, trim, to_number: of source_column'),
      source_column: z.string().optional()
        .describe('Column to read from (required for every operation except template)'),
      pattern: z.string().optional().describe('regex_extract: the regex (group 1 is extracted). split: the delimiter.'),
      index: z.number().int().min(0).optional().describe('split: which part to keep (0-based, default 0)'),
      template: z.string().optional().describe('template: e.g. "{{First}} {{Last}} <{{Email}}>"'),
      where: whereLike('Only transform the rows it passes.').optional(),
      cursor: z.string().optional()
        .describe('The pass\'s latest next_cursor, to go on after the last row it looked at. Not with restart'),
      restart: z.boolean().optional()
        .describe('true: drop the column\'s unfinished pass and start over from the first row, applying the '
          + 'operation to every row again. For rows that moved since, or different arguments. Not with cursor'),
    },
  }, async input => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const params: TransformParams = {
      sheetId: input.sheet_id,
      targetColumn: input.target_column,
      operation: input.operation as TransformOp,
      sourceColumn: input.source_column,
      pattern: input.pattern,
      index: input.index,
      template: input.template,
      where: input.where,
      cursor: input.cursor,
      restart: input.restart,
    };
    const result = await transformColumn(ctx.userId, params);
    const changed = (column: string, rows: number) => changedOf(ctx.userId, [{ sheetId: input.sheet_id,
      columns: [column], rows }]);
    if ('stopped' in result) {
      // Rows it wrote before the error stay written.
      const { error, wrote, ...more } = result.stopped;
      return errWith(error, { ...more, changed: changed(input.target_column, wrote) });
    }
    if ('unfinished' in result) {
      const { error, ...more } = result.unfinished;
      return errWith(error, { ...more, changed: [] });
    }
    if ('fail' in result) return err(result.error);
    const { updated, created_column } = result.ok;
    return ok({ ...result.ok, changed: updated || created_column
      ? changed(created_column ?? input.target_column, updated) : [] });
  });
}
