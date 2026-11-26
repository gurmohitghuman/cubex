// get_balances: the treg balance, the enrichment daily limit and what
// OpenRouter reports for the saved key, without starting or estimating
// anything (services/balances.ts; GET /v1/balances is the same read).
import { McpServer } from '@modelcontextprotocol/server';
import { readBalances } from '../services/balances';
import { McpAuthCtx, ok, missingScope, registerTool } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';

export function registerBalanceTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_balances', {
    description:
      'What the account can spend, read live: the treg balance for enrichments, the enrichment daily limit, '
      + 'OpenRouter for AI runs, and this token\'s own spend cap (access_token). Read-only: starts nothing and '
      + `costs nothing. Use it before a large run, or when a run paused on balance. ${GUIDE_POINTER}`,
    inputSchema: {},
  }, async () => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    return ok(await readBalances(ctx.userId, ctx.tokenId));
  });
}
