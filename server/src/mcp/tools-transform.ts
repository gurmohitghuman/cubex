import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { transformColumn, TransformParams } from '../services/column-transform';
import { TransformOp } from '../lib/transform-ops';
import { TRANSFORM_MAX_CALL_MS, TRANSFORM_MAX_ROWS } from '../lib/api-v1-constants';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
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
      'answer has next_cursor: call again with the same arguments and cursor set to it to go on.',
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
        .describe('next_cursor of the call before, to go on after the last row it looked at.'),
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
    };
    const result = await transformColumn(ctx.userId, params);
    return 'fail' in result ? err(result.error) : ok(result.ok);
  });
}
