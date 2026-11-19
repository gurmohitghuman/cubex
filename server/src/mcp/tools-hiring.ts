import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { ENRICH_LIST_MAX_ITEMS, HIRING_MAX_POSTED_DAYS, HIRING_MAX_ROLES } from '../lib/constants';
import { agentCheckHiring, agentCreateHiring, agentGetHiring } from '../services/hiring-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { changedOf, madeSheet } from './changed';

// hiring_signals: a ready-made table of the companies hiring for chosen roles
// (services/hiring-*.ts), checked again by hand or by an agent.
export function registerHiringTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'hiring_signals', {
    description:
      'Find the companies hiring for chosen roles, a buying signal, and see what is new at each check. action '
      + '"create" (free, searches nothing) makes a table "Hiring: <roles>": Companies (one row per company: Open '
      + 'roles, Role titles, Newest posted, Links, "New since last check" such as "New since Nov 11: 2 roles (SDR, '
      + 'BDR)", New roles, First seen), Roles (every open role found: Title, Company, Domain, Location, Posted, '
      + 'Link, First seen, Search) and Searches (one row per role title, with its country, place and age). '
      + 'action "check" (run scope) searches every row of Searches: PAID treg calls, one enrichment run (follow '
      + 'it with get_run_status, run type enrichment); only roles never found before are added, then Companies is '
      + 'summed up again. estimate_only DEFAULTS TO TRUE and returns the most it can cost and, where the job index '
      + 'has one, its free count of matching roles ("about"); call again with estimate_only:false to start. A '
      + 'check never spends more than its estimate. action "get" (free) shows the table and its last checks. Read '
      + 'Companies with read_rows (filter New roles > 0 for the companies with new roles).',
    inputSchema: z.object({
      action: z.enum(['create', 'check', 'get']).describe('create the table (free), check it (paid), or get it'),
      id: z.string().optional()
        .describe('check, get: the id create returned, or the table\'s Companies sheet id (list_tables)'),
      roles: z.array(z.string()).max(HIRING_MAX_ROLES * 10).optional()
        .describe(`create: the role titles to search for, one search each (at most ${HIRING_MAX_ROLES})`),
      country: z.string().optional().describe('create: two-letter country of the roles (US); left out: any'),
      place: z.string().optional().describe('create: a city or region (Texas), finer than the country'),
      posted_within_days: z.number().int().min(1).max(HIRING_MAX_POSTED_DAYS).nullable().optional()
        .describe('create: only roles posted in the last N days (default 30; null: any time)'),
      per_search: z.number().int().min(1).max(ENRICH_LIST_MAX_ITEMS).optional()
        .describe('create: roles each search adds at most (default 25): the price dial'),
      estimate_only: lenientBoolean().optional().describe('check: default true (only the cost)'),
      time_zone: z.string().optional()
        .describe('check: the user\'s IANA time zone (America/New_York), for the check\'s day; default UTC'),
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
