import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { PLATFORMS } from '../lib/social/platforms';
import { STEPS } from '../lib/social/names';
import { SOCIAL_MAX_DAYS, SOCIAL_MAX_POSTS_PER_SEARCH, SOCIAL_MAX_SEARCHES } from '../lib/social/input';
import { agentCreateSocial, agentFindPosts, agentGetSocial } from '../services/social-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, lenientInt } from './tool-helpers';
import { changedOf, madeSheet } from './changed';

// social_research: a ready-made table of social posts on a topic (services/social-*.ts), searched by hand or by
// an agent, with steps set up on each Posts sheet that run when asked.
export function registerSocialTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'social_research', {
    description:
      'Social posts on a topic. create (free): Searches, a Posts sheet per platform with the steps picked set up and '
      + 'not run, a Top posts view from the filters. find_posts (run scope, PAID): each platform searches every row '
      + 'of Searches, adding only new posts. estimate_only (default true): high_usd; then estimate_only false with '
      + 'max_cost_usd = high_usd. Run the steps with run_columns or each column\'s run. get: the table.',
    inputSchema: z.object({
      action: z.enum(['create', 'find_posts', 'get']).describe('find_posts is paid'),
      id: z.string().optional().describe('find_posts, get: from create, or one of its sheet ids'),
      topic: z.string().optional().describe('create: what to research'),
      searches: z.array(z.string()).max(SOCIAL_MAX_SEARCHES).optional()
        .describe('create: words to search (default: the topic)'),
      platforms: z.array(z.enum(PLATFORMS)).optional().describe('create: where to search'),
      steps: z.array(z.enum(STEPS)).optional()
        .describe('create: transcript, breakdown (AI: hook, tension, payoff, why it works), creator, comments'),
      min_views: lenientInt(0, 1e12, 'min_views must be a whole number.').optional().describe('create: Top posts'),
      min_comments: lenientInt(0, 1e9, 'min_comments must be a whole number.').optional()
        .describe('create: Top posts'),
      posted_within_days: lenientInt(1, SOCIAL_MAX_DAYS, `posted_within_days is 1 to ${SOCIAL_MAX_DAYS}.`).optional()
        .describe('create: Top posts, counted from each find_posts'),
      posts_per_search: lenientInt(1, SOCIAL_MAX_POSTS_PER_SEARCH, 'posts_per_search is too big.').optional()
        .describe('create: per platform (default 30)'),
      estimate_only: lenientBoolean().optional().describe('find_posts: default true'),
      max_cost_usd: z.number().optional().describe('find_posts: the estimate\'s high_usd'),
      time_zone: z.string().optional().describe('find_posts: IANA zone for First seen (default UTC)'),
    }).strict(),
  }, async (a) => {
    if (a.action === 'create') {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const out = await agentCreateSocial(ctx.userId, a);
      if (!('ok' in out)) return err(out.message);
      const sheets = [out.ok.searches_sheet_id, ...Object.values(out.ok.posts_sheets),
        ...(out.ok.comments_sheet_id ? [out.ok.comments_sheet_id] : [])] as string[];
      return ok({ ...out.ok, changed: changedOf(ctx.userId, sheets.map(s => madeSheet(ctx.userId, s))) });
    }
    if (a.action === 'get') {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const out = agentGetSocial(ctx.userId, a.id);
      return 'ok' in out ? ok({ ...out.ok, changed: [] }) : err(out.message);
    }
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await agentFindPosts(ctx.userId, ctx.tokenId, a.id,
      { estimateOnly: a.estimate_only, timeZone: a.time_zone, maxCostUsd: a.max_cost_usd });
    if (!('ok' in out)) {
      return err(out.estimate ? `${out.message} Estimate: ${JSON.stringify(out.estimate)}` : out.message);
    }
    return ok({ ...out.ok, changed: out.sheetId ? changedOf(ctx.userId, [{ sheetId: out.sheetId, moreComing: true }])
      : [] });
  });
}
