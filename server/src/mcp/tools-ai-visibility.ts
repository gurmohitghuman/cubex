import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AI_VISIBILITY_MAX_COMPETITORS, AI_VISIBILITY_MAX_QUESTIONS } from '../lib/constants';
import { ENGINES } from '../lib/ai-visibility/engines';
import {
  agentAskAiVisibility, agentCheckAiVisibility, agentCreateAiVisibility, agentSetAiVisibilityBrands,
} from '../services/ai-visibility-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

const ENGINE_IDS = ENGINES.map(e => e.id) as [string, ...string[]];

// ai_visibility: a ready-made table of what AI engines answer to buyer
// questions, and whether they name your brand (services/ai-visibility-*.ts).
export function registerAiVisibilityTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'ai_visibility', {
    description:
      'Check whether AI engines recommend a brand. action "create" makes a new table "AI visibility for <brand>": '
      + 'a Questions sheet (your questions; per engine a column asking it, its answer, and "You in <engine>": '
      + '"1st of 4" = your place among the brands its answer names, or "Not named"; "Named by": how many engines '
      + 'that answered name you; "Named first": the brand most engines name first) and a Cited sites sheet (every '
      + 'source an answer cites, with its question, engine, domain and "Your site"). Brands are found as whole '
      + 'words, ignoring case and accents, among `brand` and `other_brands` only. create asks nothing and costs '
      + 'nothing. action "ask" (needs the run scope) asks every engine the questions not asked yet (again:true: '
      + 'every question, fresh answers, for a later check). It is PAID treg calls: estimate_only defaults to TRUE '
      + 'and returns the cost; call again with estimate_only:false to start one enrichment run per engine '
      + '(follow them with get_run_status, run type enrichment). The formula columns fill as answers arrive. '
      + 'action "check_again" (run scope, weeks later) keeps the answers there now: it copies Questions and Cited '
      + 'sites, values only, into sheets named with the day they were asked ("Questions 2026-10-01"), adds to '
      + 'Questions "Named by on <date>" (that day\'s Named by) and "Change since <date>" ("Up 2", "Down 1", "Same", '
      + 'or "New" for a question with no answers then; blank while a different number of engines answered), then '
      + 'asks every engine every question again with fresh answers. A check that stopped (a restart, the daily '
      + 'limit) is picked up by the next: its copies stay and only the engines it didn\'t start are asked '
      + '(fresh: true starts a new check instead). '
      + 'Also PAID: estimate_only defaults to TRUE and returns the cost, the names it would use and a note when the '
      + 'answers are under three weeks old (then a change is mostly the usual variation between asks). '
      + 'action "set_brands" changes the brands looked for and works every row out again from the answers there '
      + '(free). ask, check_again and set_brands take the id create returned, or the table\'s Questions sheet id. '
      + 'The engine columns are ordinary enrichment columns and the table an ordinary table: read it '
      + 'with read_rows (group_by Named first, or Domain on Cited sites, for counts); deleting it puts it in the '
      + 'trash. Answers vary between asks: compare totals, not one question.',
    inputSchema: z.object({
      action: z.enum(['create', 'ask', 'check_again', 'set_brands']),
      id: z.string().optional()
        .describe('ask, check_again, set_brands: the id create returned, or the table\'s Questions sheet id '
          + '(list_tables)'),
      brand: z.string().optional().describe('create, set_brands: your brand, as answers would name it'),
      other_brands: z.array(z.string()).max(AI_VISIBILITY_MAX_COMPETITORS).optional()
        .describe('create, set_brands: competitors to look for in the answers (set_brands: replaces the list; '
          + 'left out, it stays)'),
      domain: z.string().optional().describe('create: your site (acme.com), to mark the sources on it'),
      country: z.string().optional().describe('create: two-letter country the questions are asked from (US)'),
      engines: z.array(z.enum(ENGINE_IDS)).optional()
        .describe(`create: default ${ENGINES.filter(e => e.defaultOn).map(e => e.id).join(', ')}`),
      questions: z.array(z.string()).max(AI_VISIBILITY_MAX_QUESTIONS * 10).optional()
        .describe('create: the questions, as a buyer would ask them (rows can be added later)'),
      again: lenientBoolean().optional().describe('ask: every question again, not only those not asked yet'),
      estimate_only: lenientBoolean().optional().describe('ask, check_again: default true (only the cost)'),
      fresh: lenientBoolean().optional()
        .describe('check_again: a new check even when a stopped one could be picked up'),
      time_zone: z.string().optional()
        .describe('check_again: the user\'s IANA time zone (America/New_York), for the day in the names; default UTC'),
    }).strict(),
  }, async (a) => {
    if (a.action === 'create') {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const out = await agentCreateAiVisibility(ctx.userId, a);
      return 'ok' in out ? ok(out.ok) : err(out.message);
    }
    if (a.action === 'ask') {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const out = await agentAskAiVisibility(ctx.userId, ctx.tokenId, a.id,
        { again: a.again === true, estimateOnly: a.estimate_only !== false });
      return 'ok' in out ? ok(out.ok) : err(out.message);
    }
    if (a.action === 'check_again') {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const out = await agentCheckAiVisibility(ctx.userId, ctx.tokenId, a.id,
        { estimateOnly: a.estimate_only !== false, timeZone: a.time_zone, fresh: a.fresh === true });
      return 'ok' in out ? ok(out.ok) : err(out.message);
    }
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentSetAiVisibilityBrands(ctx.userId, a.id, a);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
