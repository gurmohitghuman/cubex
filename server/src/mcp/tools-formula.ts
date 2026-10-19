import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FORMULA_MAX_CHARS, FORMULA_WORDS_MAX_CHARS } from '../lib/constants';
import { writeFormula } from '../services/formula-ai';
import { agentFormulaColumn } from '../services/formula-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { capToolNote } from '../lib/token-spend';

// formula_column: a column worked out for free from each row by a JavaScript
// formula, run in Cubex's sandbox (services/formula-agent.ts); write_formula:
// one from plain words, written by the sheet's AI model (services/formula-ai.ts).
export function registerFormulaTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'formula_column', {
    description:
      'Fill a column for FREE with a formula worked out from each row: no AI, no credits, no requests. Prefer it '
      + 'over run_ai_column whenever the value can be computed from the row: picking a field out of an API '
      + 'response, choosing an item of a list by a condition, joining or splitting text, math. The formula is ONE '
      + 'JavaScript expression reading cells as {{Column name}}, e.g. '
      + '{{Response}}?.emails?.find(e => e.type == "work")?.value or `${{{First}}} ${{{Last}}}` or '
      + 'Number({{Price}}) * 1.2. Cells are text: use Number() for math. A cell holding JSON (text starting '
      + 'with { or [, like a whole HTTP response written by run_http_enrichment mapping "$") arrives parsed, so '
      + 'find/filter/map work on it; this is how to pick an item by a condition, which JSONPath mappings refuse. '
      + 'Status cells ("⏳ Processing...", "❌ ...", "⏭️ ...") read as empty. Use optional chaining (?.) and '
      + 'return "" when data is missing. _ is Lodash. There is no network or file access. The result is written '
      + 'as text (objects and lists as JSON; null, undefined and NaN as an empty cell). A row the formula '
      + 'cannot work out shows "❌ <the error>" and counts in error_rows (first_error names the first). '
      + 'Writes into column, always a new column: naming a formula column already there replaces its formula and '
      + 'works every row out again, hand edits included; any other existing column is refused. auto_run (default '
      + 'true for a new column) keeps it following its inputs: new rows, and rows where a column it reads '
      + 'changes, are worked out again on their own. preview:true shows the first rows with their inputs and '
      + 'results and writes nothing; use it to check a formula first. Waits for the fill up to 10 seconds and '
      + 'returns filled_rows and error_rows; a bigger sheet returns status "filling".',
    inputSchema: z.object({
      sheet_id: z.string(),
      column: z.string().optional().describe('The formula column to write; created if it does not exist. '
        + 'Required unless preview is true'),
      formula: z.string().max(FORMULA_MAX_CHARS).describe('One JavaScript expression reading cells as {{Column}}'),
      description: z.string().max(FORMULA_WORDS_MAX_CHARS).optional()
        .describe('What the formula does, in plain words, kept with the column'),
      auto_run: lenientBoolean().optional(),
      preview: lenientBoolean().optional(),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentFormulaColumn(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'write_formula', {
    description:
      'Write a formula for formula_column from plain words ("the work email from Response", "first and last '
      + 'name joined"), using ONE small call to the sheet\'s default AI model (or model). The model sees the '
      + 'column names and what the first rows hold (the shape of JSON cells), and the formula is checked on the '
      + 'first rows before it is returned. Returns the formula, the model used, what the call cost, and a '
      + 'preview (samples with their inputs and results). Nothing is saved: pass formula to formula_column. You '
      + 'can also write the formula yourself. A request that needs judgment or outside data is refused: use '
      + 'run_ai_column or an enrichment for that.' + capToolNote(ctx.spend ?? null, false),
    inputSchema: z.object({
      sheet_id: z.string(),
      words: z.string().max(FORMULA_WORDS_MAX_CHARS).describe('What the column should hold, in plain words'),
      model: z.string().optional().describe('OpenRouter model id; default: the sheet\'s, then the account\'s'),
    }).strict(),
  }, async ({ sheet_id, words, model }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await writeFormula(ctx.userId, sheet_id, words, model ?? null);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
