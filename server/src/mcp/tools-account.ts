// get_account: the account's reads in one tool (fewer MCP tools, PR A), each action with its old tool's fields and
// answer: balances (get_balances, services/balances.ts; GET /v1/balances), usage (get_usage, services/usage.ts;
// GET /v1/usage), saved_keys (list_saved_keys, services/saved-key-uses.ts; GET /v1/saved-keys) and version
// (get_version, services/version-info.ts and version-changes.ts; GET /v1/version). Read-only: the read scope is
// enough, as a saved key's value never leaves Settings.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { USAGE_MCP_MAX_ROWS } from '../lib/constants';
import { USAGE_GROUPS, USAGE_RANGES } from '../lib/usage-query';
import { readBalances } from '../services/balances';
import { readUsage, usageAsk } from '../services/usage';
import { listSavedKeys } from '../services/saved-key-uses';
import { versionInfo } from '../services/version-info';
import { changesSince } from '../services/version-changes';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { actionFieldsProblem } from './action-fields';
import { GUIDE_POINTER } from './guides/guide';

const ACTIONS = ['balances', 'usage', 'saved_keys', 'version'] as const;
type Field = 'sheet_id' | 'group_by' | 'range' | 'from' | 'to' | 'limit' | 'name' | 'after' | 'since';
const TAKES = {
  balances: {},
  usage: { may: ['sheet_id', 'group_by', 'range', 'from', 'to', 'limit'] },
  saved_keys: { may: ['name', 'after'] },
  version: { may: ['since'] },
} as const satisfies Record<typeof ACTIONS[number], { may?: readonly Field[] }>;

export function registerAccountTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_account', {
    description:
      'The account, read-only, costs nothing. balances: what it can spend, read live: the treg balance for '
      + 'enrichments, the enrichment daily limit, OpenRouter for AI runs, and this token\'s own spend cap '
      + '(access_token); use it before a large run, or when a run paused on balance. usage: what AI, HTTP and '
      + 'enrichment runs cost and how much they ran, by column, day or run, for one sheet or the whole account. '
      + 'saved_keys: the saved API keys by name (never their values) and where each is used. version: which Cubex '
      + 'version runs and whether a newer release is out; with since (the version you last used), what changed '
      + `for agents in every release after it: call it when a tool you expect is missing. ${GUIDE_POINTER}`,
    inputSchema: {
      action: z.enum(ACTIONS).describe('balances, usage, saved_keys or version'),
      sheet_id: z.string().optional().describe('usage: one sheet; leave out for the whole account'),
      group_by: z.enum(USAGE_GROUPS).optional().describe('usage: column (default), day or run'),
      range: z.enum(USAGE_RANGES.filter(r => r !== 'custom') as [string, ...string[]]).optional()
        .describe('usage: this_month (default), this_week, last_week or last_month; or pass from and to'),
      from: z.string().optional().describe('usage: first day, YYYY-MM-DD (with to)'),
      to: z.string().optional().describe('usage: last day, YYYY-MM-DD (with from), included'),
      limit: z.number().int().min(1).max(USAGE_MCP_MAX_ROWS).optional()
        .describe(`usage: rows, 1-${USAGE_MCP_MAX_ROWS} (default ${USAGE_MCP_MAX_ROWS}): the costliest columns or `
          + 'the newest days or runs'),
      // name and after take any length: each is a saved key's name, and one saved before the cap can be longer.
      name: z.string().min(1).optional().describe('saved_keys: just this key (any case), with more of its places'),
      after: z.string().min(1).optional().describe('saved_keys: the keys after this name: the next_after of a call'),
      since: z.string().optional()
        .describe('version: a Cubex release, like "v0.8.12": the answer then lists what changed for agents after it'),
    },
  }, async ({ action, ...a }: { action: typeof ACTIONS[number] } & Partial<Record<Field, any>>) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const problem = actionFieldsProblem<typeof ACTIONS[number], Field>(action, a, TAKES);
    if (problem) return err(problem);
    if (action === 'balances') return ok(await readBalances(ctx.userId, ctx.tokenId));
    if (action === 'usage') {
      const { sheet_id, ...rest } = a;
      const out = usageAsk(ctx.userId, sheet_id ?? null, { ...rest, limit: rest.limit ?? USAGE_MCP_MAX_ROWS });
      if ('fail' in out) return err(out.message);
      return ok(readUsage(out.ok.scope, out.ok.query));
    }
    if (action === 'saved_keys') {
      const out = listSavedKeys(ctx.userId, { name: a.name, after: a.after });
      return 'fail' in out ? err(out.message) : ok(out.ok);
    }
    const info = versionInfo(ctx.userId);
    if (a.since === undefined) return ok(info);
    const changes = changesSince(a.since);
    return 'error' in changes ? err(changes.error) : ok({ ...info, changes_since: changes.ok });
  });
}
