import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { transformColumn, TransformParams } from '../services/column-transform';
import { TransformOp } from '../lib/transform-ops';
import { McpAuthCtx, ok, err, missingScope, registerTool, rowConditionSchema as condition } from './tool-helpers';


export function registerTransformTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'transform_column', {
    description:
      'Transform a column server-side with NO AI calls and NO credits — use this instead of run_ai_column for mechanical string work. ' +
      'operation: regex_extract (capture group 1 of pattern), split (by pattern delimiter, keep part index), template ("{{col}} …" from any columns), upper, lower, trim, to_number. ' +
      'Writes into target_column (created if missing). Example: turn "8 | B2B SaaS" into a numeric score with regex_extract pattern "^(\\\\d+)". Optional where limits which rows are transformed.',
    inputSchema: {
      sheet_id: z.string(),
      target_column: z.string().describe('Column to write into; created if it does not exist'),
      operation: z.enum(['regex_extract', 'split', 'template', 'upper', 'lower', 'trim', 'to_number']),
      source_column: z.string().optional().describe('Column to read from (required for every operation except template)'),
      pattern: z.string().optional().describe('regex_extract: the regex (group 1 is extracted). split: the delimiter.'),
      index: z.number().int().min(0).optional().describe('split: which part to keep (0-based, default 0)'),
      template: z.string().optional().describe('template: e.g. "{{First}} {{Last}} <{{Email}}>"'),
      where: z.array(condition).min(1).optional().describe('Only transform rows matching all conditions'),
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
    };
    const result = transformColumn(ctx.userId, params);
    return 'fail' in result ? err(result.error) : ok(result.ok);
  });
}
