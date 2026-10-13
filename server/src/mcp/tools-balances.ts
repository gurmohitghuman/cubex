// get_balances: the treg balance, the enrichment daily limit and what
// OpenRouter reports for the saved key, without starting or estimating
// anything (services/balances.ts; GET /v1/balances is the same read).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readBalances } from '../services/balances';
import { McpAuthCtx, ok, missingScope, registerTool } from './tool-helpers';

export function registerBalanceTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_balances', {
    description:
      'What the account can spend, read live: treg {balance_usd, on_hold_usd} for enrichments, '
      + 'enrichment_daily_limit {limit_usd, used_today_usd, remaining_usd}, and openrouter for AI runs '
      + '{balance_usd (account credits, often null: OpenRouter shares it only with a management key), '
      + 'key_limit_usd, key_limit_remaining_usd, key_usage_usd, byok_usage_usd, available_usd}. A part that '
      + 'is not set up or can\'t be reached says so in error. Read-only: starts nothing and costs nothing. Use it '
      + 'before a large run, or when a run paused on balance. OpenRouter holds each running AI call\'s possible '
      + 'cost, so a high concurrency needs more free credit than the run will spend: run_ai_column\'s '
      + 'estimate_only reports that as in_flight.',
    inputSchema: {},
  }, async () => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    return ok(await readBalances(ctx.userId));
  });
}
