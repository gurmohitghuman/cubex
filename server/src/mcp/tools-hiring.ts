import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  ENRICH_LIST_MAX_ITEMS, HIRING_MAX_POSTED_DAYS, HIRING_MAX_ROLES,
} from '../lib/constants';
import { perSearchRefusal, postedDaysRefusal } from '../lib/hiring/input';
import { EMPLOYMENT_TYPES, SENIORITY_LEVELS } from '../lib/hiring/filters';
import { agentCheckHiring, agentCreateHiring, agentGetHiring } from '../services/hiring-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, lenientInt } from './tool-helpers';
import { changedOf, madeSheet } from './changed';

// hiring_signals: a ready-made table of the companies hiring for chosen roles
// (services/hiring-*.ts), checked again by hand or by an agent.
const words = () => z.union([z.array(z.string()), z.string()]).optional();
export function registerHiringTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'hiring_signals', {
    description:
      'Companies hiring for chosen roles. create (free): a table of Companies (New roles since the last check), '
      + 'Roles and Searches. check (run scope, PAID): adds only new roles, sums up Companies. estimate_only '
      + '(default true): high_usd, its most, and a free count; then estimate_only false with max_cost_usd = '
      + 'high_usd. get: the checks.',
    inputSchema: z.object({
      action: z.enum(['create', 'check', 'get']).describe('check is paid'),
      id: z.string().optional()
        .describe('check, get: from create'),
      roles: z.union([z.array(z.string()), z.string()]).optional()
        .describe(`create: role titles (a list or lines; at most ${HIRING_MAX_ROLES})`),
      country: z.string().nullable().optional().describe('create: country code (US)'),
      place: z.string().nullable().optional().describe('create: city or region'),
      posted_within_days: lenientInt(1, HIRING_MAX_POSTED_DAYS, postedDaysRefusal('posted_within_days'))
        .nullable().optional()
        .describe('create: posted within N days (default 30; null: any)'),
      per_search: lenientInt(1, ENRICH_LIST_MAX_ITEMS, perSearchRefusal('per_search')).optional()
        .describe('create: roles per search (default 25)'),
      // lib/hiring/filters.ts: a table with any of these searches the one job index that takes them.
      description_words: words().describe('create: only roles whose description mentions any of these'),
      leave_out_description_words: words().describe('create: leave out roles whose description mentions one'),
      leave_out_title_words: words().describe('create: leave out roles whose title has one'),
      seniority: words().describe(`create: only ${SENIORITY_LEVELS.join(', ')}`),
      employment_types: words().describe(`create: only ${EMPLOYMENT_TYPES.join(', ')}`),
      companies: words().describe('create: only these companies (websites)'),
      estimate_only: lenientBoolean().optional().describe('check: default true'),
      // Checked as /api/v1 checks it (lib/hiring/input.ts checkMostOf): the same refusals.
      max_cost_usd: z.number().optional()
        .describe('check: the estimate\'s high_usd'),
      time_zone: z.string().optional()
        .describe('check: IANA zone (default UTC)'),
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
      { estimateOnly: a.estimate_only, timeZone: a.time_zone, maxCostUsd: a.max_cost_usd });
    if (!('ok' in out)) {
      return err(out.estimate ? `${out.message} Estimate: ${JSON.stringify(out.estimate)}` : out.message);
    }
    const sheetId = 'sheetId' in out ? out.sheetId : null;
    // The search fills Searches' status column and adds rows to Roles; Companies follows when it's done.
    return ok({ ...out.ok, changed: sheetId ? changedOf(ctx.userId, [{ sheetId, moreComing: true }]) : [] });
  });
}
