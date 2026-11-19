import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { ENRICH_LIST_MAX_ITEMS, HIRING_MAX_POSTED_DAYS, HIRING_MAX_ROLES } from '../lib/constants';
import { agentCheckHiring, agentCreateHiring, agentGetHiring } from '../services/hiring-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, lenientInt } from './tool-helpers';
import { changedOf, madeSheet } from './changed';

// hiring_signals: a ready-made table of the companies hiring for chosen roles
// (services/hiring-*.ts), checked again by hand or by an agent.
export function registerHiringTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'hiring_signals', {
    description:
      'Companies hiring for chosen roles. create (free): a table "Hiring: <roles>" with Companies (a row per '
      + 'company, with New roles since the last check), Roles and Searches (a row per role title). check (run '
      + 'scope, PAID): one enrichment run adding only roles never found before, then Companies is summed up. '
      + 'estimate_only defaults to true: the most it can cost and a free count of roles; a check never spends '
      + 'more. get (free): the table and its checks.',
    inputSchema: z.object({
      action: z.enum(['create', 'check', 'get']).describe('create (free), check (paid) or get'),
      id: z.string().optional()
        .describe('check, get: the id from create'),
      roles: z.array(z.string()).optional()
        .describe(`create: role titles, one search each (at most ${HIRING_MAX_ROLES})`),
      country: z.string().optional().describe('create: country code (US); none: any'),
      place: z.string().optional().describe('create: city or region'),
      posted_within_days: lenientInt(1, HIRING_MAX_POSTED_DAYS, `posted_within_days: 1 to ${HIRING_MAX_POSTED_DAYS}`)
        .nullable().optional()
        .describe('create: posted in the last N days (default 30; null: any)'),
      per_search: lenientInt(1, ENRICH_LIST_MAX_ITEMS, `per_search: 1 to ${ENRICH_LIST_MAX_ITEMS}`).optional()
        .describe('create: most roles per search (default 25)'),
      estimate_only: lenientBoolean().optional().describe('check: default true'),
      time_zone: z.string().optional()
        .describe('check: IANA time zone (default UTC)'),
    }).strict(),
  }, async (a) => {
    if (a.action === 'create') {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const out = await agentCreateHiring(ctx.userId, a);
      if (!('ok' in out)) return err(out.message);
      const { companies_sheet_id: companies, roles_sheet_id: roles, searches_sheet_id: searches } = out.ok;
      return ok({ ...out.ok, changed: changedOf(ctx.userId, [madeSheet(ctx.userId, companies),
        madeSheet(ctx.userId, roles), madeSheet(ctx.userId, searches)]) });
    }
    if (a.action === 'get') {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const out = agentGetHiring(ctx.userId, a.id);
      return 'ok' in out ? ok({ ...out.ok, changed: [] }) : err(out.message);
    }
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await agentCheckHiring(ctx.userId, ctx.tokenId, a.id,
      { estimateOnly: a.estimate_only !== false, timeZone: a.time_zone });
    if (!('ok' in out)) return err(out.message);
    const sheetId = 'sheetId' in out ? out.sheetId : null;
    // The search fills Searches' status column and adds rows to Roles; Companies follows when it's done.
    return ok({ ...out.ok, changed: sheetId ? changedOf(ctx.userId, [{ sheetId, moreComing: true }]) : [] });
  });
}
