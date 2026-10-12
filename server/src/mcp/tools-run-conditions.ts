// "Only run if" tools: check a rule on a sheet (free) and write one from plain
// words (one small AI call on the default model). Thin wrappers over
// services/run-condition-ai.ts, as the drawers and /api/v1 use. The scope
// check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_RULE_CHARS } from '../lib/run-condition';
import { RULE_WORDS_MAX_CHARS } from '../lib/constants-ai';
import { checkRuleOnSheet, generateRule } from '../services/run-condition-ai';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { RULE_LANGUAGE } from './run-if-schema';

export function registerRunConditionTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server,
    'check_run_condition',
    {
      description: 'Check an "Only run if" rule (the run_if of run_ai_column, run_http_enrichment, run_enrichment '
        + 'and set_auto_run) on a sheet without running anything: returns the rule as Cubex stores it, '
        + 'rows_passing / rows_skipped over the whole sheet, and the first rows with the values the rule read and '
        + 'whether each passes. A misspelled column or a bad rule is refused with the reason. Free: no AI. '
        + RULE_LANGUAGE,
      inputSchema: {
        sheet_id: z.string(),
        rule: z.string().max(MAX_RULE_CHARS)
          .describe('The rule, e.g. {{Email status}} is "valid" AND {{Title}} contains "head"'),
      },
    },
    async ({ sheet_id, rule }: { sheet_id: string; rule: string }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const r = await checkRuleOnSheet(ctx.userId, sheet_id, rule);
      return 'fail' in r ? err(r.message) : ok(r.ok);
    },
  );

  registerTool(server,
    'write_run_condition',
    {
      description: 'Write an "Only run if" rule from plain words ("SaaS or fintech companies with more than 50 '
        + 'people"), using ONE small call to the sheet\'s default AI model (or model). The model sees the column '
        + 'names and a few values from the first rows, so the rule matches the sheet\'s real spelling. Returns the '
        + 'rule, the model used, what the call cost, and the same check as check_run_condition. Nothing runs: '
        + 'pass check.rule as run_if to a run. You can also write a rule yourself (see check_run_condition). '
        + 'A request that needs judgment no column holds ("is a good fit") is refused: run an AI column that '
        + 'answers it first, then write a rule on that column.',
      inputSchema: {
        sheet_id: z.string(),
        text: z.string().max(RULE_WORDS_MAX_CHARS).describe('Which rows should run, in plain words'),
        model: z.string().optional().describe('OpenRouter model id; default: the sheet\'s, then the account\'s'),
      },
    },
    async ({ sheet_id, text, model }: { sheet_id: string; text: string; model?: string }) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const r = await generateRule(ctx.userId, sheet_id, text, model ?? null);
      return 'fail' in r ? err(r.message) : ok(r.ok);
    },
  );
}
