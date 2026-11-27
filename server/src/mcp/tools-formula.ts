import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { FORMULA_MAX_CHARS, FORMULA_WORDS_MAX_CHARS } from '../lib/constants';
import { writeFormula } from '../services/formula-ai';
import { agentFormulaColumn } from '../services/formula-agent';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { fillChanged } from './changed';
import { GUIDE_POINTER } from './guides/guide';
import { capToolNote } from '../lib/token-spend';

// formula_column: a column worked out for free from each row by a JavaScript formula, run in Cubex's sandbox
// (services/formula-agent.ts); with from_words (write_formula before v0.8.47) one is written from plain words by
// the sheet's AI model instead (services/formula-ai.ts), and nothing is saved. Each part's fields are exported for
// REST's bodies (openapi/routes-fill.ts), which stay what the two tools took.
export const FORMULA_INPUT = {
  sheet_id: z.string().describe(SHEET_ID),
  column: z.string().optional().describe('The formula column to write; created if it does not exist. '
    + 'Required unless preview is true'),
  formula: z.string().max(FORMULA_MAX_CHARS).describe('One JavaScript expression reading cells as {{Column}}'),
  description: z.string().max(FORMULA_WORDS_MAX_CHARS).optional()
    .describe('What the formula does, in plain words, kept with the column'),
  auto_run: lenientBoolean().optional()
    .describe('Default true for a new column: new rows, and rows where a column it reads changes, are worked '
      + 'out again on their own'),
  preview: lenientBoolean().optional().describe('true: show the first rows with inputs and results; write nothing'),
};
export const WRITE_FORMULA_INPUT = {
  sheet_id: z.string().describe(SHEET_ID),
  words: z.string().max(FORMULA_WORDS_MAX_CHARS).describe('What the column should hold, in plain words'),
  model: z.string().optional().describe('OpenRouter model id; default: the sheet\'s, then the account\'s'),
};

export function registerFormulaTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'formula_column', {
    description:
      'To clean names, companies, emails or phones, or to take the domain out of an email or a URL, use '
      + 'clean_column instead. Fill a column for FREE with a formula worked out from each row: no AI, no credits, '
      + 'no requests. '
      + 'Prefer it over run_ai_column whenever the value can be computed from the row: picking a field out of an '
      + 'API response, choosing an item of a list by a condition, joining or splitting text, math. The formula is ONE '
      + 'JavaScript expression reading cells as {{Column name}}, e.g. '
      + '{{Response}}?.emails?.find(e => e.type == "work")?.value or `${{{First}}} ${{{Last}}}` or '
      + 'Number({{Price}}) * 1.2. Cells are text: use Number() for math. JSON cells arrive parsed. Use '
      + 'optional chaining (?.) and return "" when data is missing. '
      + 'Writes into column, always a new column: naming a formula column already there replaces its formula and '
      + 'works every row out again, hand edits included; any other existing column is refused. Check a formula '
      + 'with preview:true first. FROM_WORDS in place of formula ("the work email from Response") has the sheet\'s '
      + 'AI model write one, in ONE small call that costs money; nothing is saved: pass the formula it answers here '
      + 'again. Waits for the fill up to 10 '
      + `seconds and returns filled_rows and error_rows; a bigger sheet returns status "filling".`
      + capToolNote(ctx.spend ?? null, false) + ` ${GUIDE_POINTER}`,
    inputSchema: z.object({
      ...FORMULA_INPUT,
      formula: FORMULA_INPUT.formula.optional()
        .describe('One JavaScript expression reading cells as {{Column}}; required unless from_words'),
      from_words: WRITE_FORMULA_INPUT.words.optional()
        .describe('In place of formula: what the column should hold, in plain words; an AI call writes the formula'),
      model: WRITE_FORMULA_INPUT.model.describe('from_words: OpenRouter model id; default: the sheet\'s, then the '
        + 'account\'s'),
    }).strict(),
  }, async ({ sheet_id, from_words, model, ...a }) => {
    if (from_words !== undefined) {
      const extra = Object.keys(a).filter(k => a[k as keyof typeof a] !== undefined);
      if (extra.length) {
        return err(`${extra.join(' and ')} ${extra.length > 1 ? 'are' : 'is'} not for from_words: it takes sheet_id, `
          + 'from_words and model, and saves nothing. Pass the formula it answers as formula.');
      }
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const out = await writeFormula(ctx.userId, sheet_id, from_words, model ?? null);
      return 'ok' in out ? ok({ ...out.ok, changed: [] }) : err(out.message);
    }
    if (model !== undefined) return err('model goes with from_words only: a formula column makes no AI calls.');
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const { formula } = a;
    if (formula === undefined) return err('Pass formula, or from_words to have one written from plain words.');
    const out = await agentFormulaColumn(ctx.userId, sheet_id, { ...a, formula });
    return 'ok' in out ? ok({ ...out.ok, changed: fillChanged(ctx.userId, sheet_id, out.ok) }) : err(out.message);
  });
}
