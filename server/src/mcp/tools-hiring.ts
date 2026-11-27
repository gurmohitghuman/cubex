import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  ENRICH_LIST_MAX_ITEMS, HIRING_MAX_MIN_ROLES, HIRING_MAX_POSTED_DAYS, HIRING_MAX_ROLES,
} from '../lib/constants';
import { perSearchRefusal, postedDaysRefusal } from '../lib/hiring/input';
import { EMPLOYMENT_TYPES, SENIORITY_LEVELS } from '../lib/hiring/filters';
import { minRolesRefusal } from '../lib/hiring/company-filters';
import { agentCheckHiring, agentCreateHiring, agentGetHiring, agentUpdateHiring } from '../services/hiring-agent';
import { agentFindBuyers } from '../services/hiring-buyer-agent';
import { agentOpenRoles } from '../services/open-roles-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, lenientInt } from './tool-helpers';
import { changedOf, madeSheet } from './changed';

// hiring_signals: a ready-made table of the companies hiring for chosen roles
// (services/hiring-*.ts), checked again by hand or by an agent; and open_roles,
// the same roles at the companies on the agent's own sheet (services/open-roles.ts).
const words = () => z.union([z.array(z.string()), z.string()]).optional();
export function registerHiringTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'hiring_signals', {
    description:
      'Companies hiring for chosen roles. create (free): a table of Companies (New roles since the last check), '
      + 'Roles and Searches. check (run scope, PAID): adds only new roles, sums up Companies. estimate_only '
      + '(default true): high_usd, its most, and a free count; then estimate_only false with max_cost_usd = '
      + 'high_usd. get: the checks. update (free): min_roles and leave_out_companies, from the next check. '
      + 'find_buyers (run scope, PAID): the person each company without one yet would buy through (Buyer, title, '
      + 'LinkedIn, verified email on Companies). estimate_only (default true) changes nothing; the run adds the '
      + 'columns the first time (write scope too). '
      + 'open_roles (run scope, PAID): roles at the companies on sheet_id (website_column) into an Open roles '
      + 'sheet, counted per company; estimate_only as check.',
    inputSchema: z.object({
      action: z.enum(['create', 'check', 'get', 'update', 'find_buyers', 'open_roles'])
        .describe('check, find_buyers and open_roles are paid'),
      id: z.string().optional()
        .describe('check, get, update, find_buyers: from create'),
      roles: z.union([z.array(z.string()), z.string()]).optional()
        .describe(`create, open_roles: role titles (a list or lines; at most ${HIRING_MAX_ROLES})`),
      country: z.string().nullable().optional().describe('create, open_roles: country code (US)'),
      place: z.string().nullable().optional().describe('create, open_roles: city or region'),
      posted_within_days: lenientInt(1, HIRING_MAX_POSTED_DAYS, postedDaysRefusal('posted_within_days'))
        .nullable().optional()
        .describe('create, open_roles: posted within N days (default 30; null: any)'),
      sheet_id: z.string().optional().describe('open_roles: the sheet of companies'),
      website_column: z.string().optional().describe('open_roles: its column of company websites'),
      per_company: lenientInt(1, ENRICH_LIST_MAX_ITEMS, perSearchRefusal('per_company')).optional()
        .describe('open_roles: roles per company at most (default 10)'),
      per_search: lenientInt(1, ENRICH_LIST_MAX_ITEMS, perSearchRefusal('per_search')).optional()
        .describe('create: roles per search (default 25)'),
      // lib/hiring/filters.ts: a table with any of these searches the one job index that takes them.
      description_words: words().describe('create: only roles whose description mentions any of these'),
      leave_out_description_words: words().describe('create: leave out roles whose description mentions one'),
      leave_out_title_words: words().describe('create: leave out roles whose title has one'),
      seniority: words().describe(`create: only ${SENIORITY_LEVELS.join(', ')}`),
      employment_types: words().describe(`create: only ${EMPLOYMENT_TYPES.join(', ')}`),
      companies: words().describe('create: only these companies (websites)'),
      // lib/hiring/company-filters.ts: which companies get a Companies row; the search stays the same.
      min_roles: lenientInt(1, HIRING_MAX_MIN_ROLES, minRolesRefusal('min_roles')).optional()
        .nullable().describe('create, update: companies with fewer matching roles get no Companies row (default 1). '
          + 'Their roles are still searched and paid for.'),
      leave_out_companies: words().nullable().describe('create, update: these companies (websites) get no Companies '
        + 'row. Their roles are still searched and paid for.'),
      buyer_titles: words().describe('find_buyers: job titles to look for at each company (default: get\'s '
        + 'buyer.titles, or its starting_titles the first time)'),
      estimate_only: lenientBoolean().optional().describe('check, find_buyers, open_roles: default true'),
      // Checked as /api/v1 checks it (lib/hiring/input.ts checkMostOf): the same refusals.
      max_cost_usd: z.number().optional()
        .describe('check, find_buyers, open_roles: the estimate\'s high_usd'),
      time_zone: z.string().optional()
        .describe('check, open_roles: IANA zone (default UTC)'),
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
    if (a.action === 'update') {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const { action: _a, id, ...rest } = a;
      const out = agentUpdateHiring(ctx.userId, id, rest);
      return 'ok' in out ? ok({ ...out.ok, changed: [] }) : err(out.message);
    }
    if (a.action === 'get') {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const out = agentGetHiring(ctx.userId, a.id);
      return 'ok' in out ? ok({ ...out.ok, changed: [] }) : err(out.message);
    }
    if (a.action === 'find_buyers') {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const out = await agentFindBuyers(ctx.userId, a.id, a, ctx.scopes.has('write'));
      if (!('ok' in out)) {
        return err(out.estimate ? `${out.message} Estimate: ${JSON.stringify(out.estimate)}` : out.message);
      }
      // The columns it saved, empty; a run fills Companies from now on.
      const touched = out.added.length || out.started
        ? [{ sheetId: out.companiesSheetId, columns: out.added, moreComing: out.started }] : [];
      return ok({ ...out.ok, changed: changedOf(ctx.userId, touched) });
    }
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    if (a.action === 'open_roles') {
      const { action: _a, sheet_id: sheetId, ...body } = a;
      const out = await agentOpenRoles(ctx.userId, ctx.tokenId, sheetId, body);
      if (!('ok' in out)) {
        return err(out.estimate ? `${out.message} Estimate: ${JSON.stringify(out.estimate)}` : out.message);
      }
      // The run fills the sheet's status column and adds rows to the Open roles sheet (new the first time).
      const made = typeof out.ok.roles_sheet_id === 'string' ? [{ sheetId: out.ok.roles_sheet_id, moreComing: true }]
        : [];
      return ok({ ...out.ok, changed: out.sheetId
        ? changedOf(ctx.userId, [{ sheetId: out.sheetId, moreComing: true }, ...made]) : [] });
    }
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
