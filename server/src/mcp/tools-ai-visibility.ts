import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
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
      'Check whether AI engines recommend a brand, and track it over time. action "create" (free, asks nothing) '
      + 'makes a table "AI visibility for <brand>": a Questions sheet (per engine a column asking it, its answer, '
      + 'and "You in <engine>": "1st of 4" = your place among the brands named, or "Not named"; "Named by": how '
      + 'many engines name you; "Named first": the brand most engines name first) and a Cited sites sheet (every '
      + 'source an answer cites, with "Your site"). Brands are matched as whole words, ignoring case and accents, '
      + 'among brand and other_brands only. '
      + 'action "ask" (run scope) asks every engine the questions not asked yet: PAID treg calls, one enrichment '
      + 'run per engine (follow them with get_run_status, run type enrichment); the formula columns fill as '
      + 'answers come. action "check_again" (weeks later) copies Questions and Cited sites, values only, into '
      + 'sheets named with '
      + 'the day they were asked, adds "Named by on <date>" and "Change since <date>" ("Up 2", "Down 1", "Same", '
      + '"New"), then asks every question again: also PAID, and it notes answers under three weeks old (a change '
      + 'then is mostly the usual variation). A stopped check is picked up by the next one. ask and check_again: '
      + 'estimate_only DEFAULTS TO TRUE and returns the cost; call again with estimate_only:false to start. '
      + 'action "set_brands" changes the brands and works every row out again (free). '
      + 'Read the table with read_rows (group_by Named first, or Domain on Cited sites, for counts). Answers vary '
      + 'between asks: compare totals, not one question.',
    inputSchema: z.object({
      action: z.enum(['create', 'ask', 'check_again', 'set_brands'])
        .describe('create the table (free), ask the engines, check_again later, or set_brands (free)'),
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
