import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { transformColumn, TransformParams } from '../services/column-transform';
import { TransformOp } from '../lib/transform-ops';
import { TRANSFORM_MAX_CALL_MS, TRANSFORM_MAX_ROWS } from '../lib/api-v1-constants';
import { McpAuthCtx, ok, err, errWith, missingScope, registerTool } from './tool-helpers';
import { WHERE_LANGUAGE, whereSchema } from './where-schema';


export function registerTransformTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'transform_column', {
    description:
      'Transform a column server-side with NO AI calls and NO credits — use this instead of run_ai_column for mechanical string work. ' +
      'For names, company names, emails, domains, phones, Title Case and spaces use clean_column, ' +
      'which keeps the column cleaning new rows. ' +
      'operation: regex_extract (capture group 1 of pattern), split (by pattern delimiter, keep part index), template ("{{col}} …" from any columns), upper, lower, trim, to_number. ' +
      'Writes into target_column (created if missing). Example: turn "8 | B2B SaaS" into a numeric score with ' +
      'regex_extract pattern "^(\\\\d+)". Optional where limits which rows are transformed. ' +
      `A call writes at most ${TRANSFORM_MAX_ROWS.toLocaleString('en-US')} rows or works about ` +
      `${TRANSFORM_MAX_CALL_MS / 1000} seconds; the rows it wrote stay written. When it stops with rows left, the ` +
      'answer has next_cursor: call again with the same arguments and cursor set to it to go on. If it stops on ' +
      'an error after writing rows, the error carries next_cursor and rows_done: go on with that cursor, never ' +
      'start over (the rows written would get the operation twice). Until a pass that wrote rows gets to the end, ' +
      'any call writing the same column without its cursor is refused with the cursor and rows_done; restart: ' +
      'true starts the column over from the first row instead. A cursor works only while its pass is open and ' +
      'only as the latest one the pass answered; the pass ends when it reaches the end or restarts, or when its ' +
      'column is deleted for good. If its rows move (a sort, a replace or an import undone, removed duplicates, ' +
      'rows restored to other places), every call into its column is refused until restart: true, unless it had ' +
      'done no rows. Sent to the trash with its column or sheet, it comes back with the restore; a copy of the ' +
      'sheet gets a pass of its own.',
    inputSchema: {
      sheet_id: z.string(),
      target_column: z.string().describe('Column to write into; created if it does not exist'),
      operation: z.enum(['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number']),
      source_column: z.string().optional()
        .describe('Column to read from (required for every operation except template)'),
      pattern: z.string().optional().describe('regex_extract: the regex (group 1 is extracted). split: the delimiter.'),
      index: z.number().int().min(0).optional().describe('split: which part to keep (0-based, default 0)'),
      template: z.string().optional().describe('template: e.g. "{{First}} {{Last}} <{{Email}}>"'),
      where: whereSchema.optional().describe(`Only transform rows matching it. ${WHERE_LANGUAGE}`),
      cursor: z.string().optional()
        .describe('The latest next_cursor of the pass, to go on after the last row it looked at.'),
      restart: z.boolean().optional()
        .describe('true: discard the column\'s unfinished pass (a call that stopped with next_cursor) and start '
          + 'over from the first row, applying the operation to every row again. Use it when rows changed since '
          + 'the pass stopped, or to run the column with different arguments. Not with cursor.'),
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
    if ('stopped' in result || 'unfinished' in result) {
      const { error, ...more } = 'stopped' in result ? result.stopped : result.unfinished;
      return errWith(error, more);
    }
    return 'fail' in result ? err(result.error) : ok(result.ok);
  });
}
