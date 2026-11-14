// Assembles Cubex's MCP server for ONE authenticated request. The protocol is
// stateless (mcp/http-entry.ts) and the Bearer token is the identity, so a fresh
// server instance per request keeps every tool handler cleanly closed over
// the caller's userId + scopes — no state can leak between calls by
// construction. Construction is cheap (tool registration, no I/O).
import { McpServer } from '@modelcontextprotocol/server';
import { McpAuthCtx } from './tool-helpers';
import { registerReadTools } from './tools-read';
import { registerRowTools } from './tools-rows';
import { registerColumnTools } from './tools-columns';
import { registerRunStartTools } from './tools-run-start';
import { registerRunManageTools } from './tools-run-manage';
import { registerRunUndoTool } from './tools-run-undo';
import { registerRunStatusTool } from './tools-run-status';
import { registerRunResultTools } from './tools-run-results';
import { registerOverviewTool, registerWorkspaceTools } from './tools-workspace';
import { registerStructureTools } from './tools-structure';
import { registerImportTools } from './tools-import';
import { registerLinkTools } from './tools-links';
import { registerModelTools } from './tools-models';
import { registerTransferTool } from './tools-transfer';
import { registerTransformTool } from './tools-transform';
import { registerEnrichTools } from './tools-enrich';
import { registerAiVisibilityTool } from './tools-ai-visibility';
import { registerWaterfallTools } from './tools-waterfall';
import { registerEnrichManageTools } from './tools-enrich-manage';
import { registerBalanceTools } from './tools-balances';
import { registerUsageTools } from './tools-usage';
import { registerVersionTool } from './tools-version';
import { registerTrashTools } from './tools-trash';
import { registerRunConditionTools } from './tools-run-conditions';
import { registerCleanTool } from './tools-clean';
import { registerFormulaTool } from './tools-formula';
import { registerLookupTool } from './tools-lookup';
import { registerDedupeTool } from './tools-dedupe';
import { registerSetupTools } from './tools-setups';
import { registerSetupRunTools } from './tools-setup-runs';
import { registerSetupVersionTools } from './tools-setup-versions';
import { registerRunWebhookTools } from './tools-run-webhooks';
import { registerSavedKeyTools } from './tools-saved-keys';
import { registerViewTools } from './tools-views';
import { MCP_LIST_CACHE_TTL_MS } from '../lib/api-v1-constants';
import { refuseToolListCursor } from './list-cursor';
import { runningBuild } from '../lib/cubex-version';
import { answerReplacedTools } from './replaced-tools';
import { answerErrorsWithNextSteps } from './error-answers';
import { serverInstructions } from './instructions';

// The name and version every answer carries (serverInfo): the running release ("v0.8.12"), or the build
// as the installer recorded it when it isn't a release, as get_version says (lib/cubex-version.ts);
// "unknown" for a build that doesn't record it (Docker, Coolify).
function serverInfo(running: ReturnType<typeof runningBuild>) {
  return { name: 'cubex', version: running.version ?? running.build ?? 'unknown' };
}
// 2026-07-28 caching hints. The instructions and tool descriptions name this
// token's spend cap (and some descriptions its scopes), so neither answer may be
// shared with another token.
const CACHE_HINT = { ttlMs: MCP_LIST_CACHE_TTL_MS, cacheScope: 'private' } as const;

export function buildMcpServer(ctx: McpAuthCtx): McpServer {
  const running = runningBuild();
  const server = new McpServer(
    serverInfo(running),
    {
      cacheHints: { 'server/discover': CACHE_HINT, 'tools/list': CACHE_HINT },
      instructions: serverInstructions(ctx.spend ?? null, running),
    },
  );
  // Cubex sends no list-changed notices. The list changes with a new version (the instructions name it,
  // and a call to a tool it removed or renamed says what replaced it), and descriptions with the token's
  // cap and spend. A subscriptions/listen is acknowledged empty and closed.
  // Declared here, not in the options above: there McpServer installs tools/list
  // at once, and the cursor, replaced-tool and error checks must wrap it before the first tool installs it.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  refuseToolListCursor(server);
  answerReplacedTools(server);
  answerErrorsWithNextSteps(server, ctx);
  registerAllTools(server, ctx);
  return server;
}

// Every tool, in order: tools/list answers in this order on every call, for
// every token (the spec asks for a fixed order, which keeps clients' caches and
// prompt caches valid). The OpenAPI document (server/src/openapi/tool-schemas.ts)
// also calls it, on a stand-in server, to read the tools' input schemas.
export function registerAllTools(server: McpServer, ctx: McpAuthCtx) {
  registerOverviewTool(server, ctx);
  registerReadTools(server, ctx);
  registerRowTools(server, ctx);
  registerColumnTools(server, ctx);
  registerRunStartTools(server, ctx);
  registerRunConditionTools(server, ctx);
  registerRunStatusTool(server, ctx);
  registerRunManageTools(server, ctx);
  registerRunUndoTool(server, ctx);
  registerRunResultTools(server, ctx);
  registerWorkspaceTools(server, ctx);
  registerStructureTools(server, ctx);
  registerImportTools(server, ctx);
  registerLinkTools(server, ctx);
  registerModelTools(server, ctx);
  registerEnrichTools(server, ctx);
  registerWaterfallTools(server, ctx);
  registerEnrichManageTools(server, ctx);
  registerAiVisibilityTool(server, ctx);
  registerBalanceTools(server, ctx);
  registerUsageTools(server, ctx);
  registerVersionTool(server, ctx);
  registerTrashTools(server, ctx);
  registerCleanTool(server, ctx);
  registerFormulaTool(server, ctx);
  registerLookupTool(server, ctx);
  registerDedupeTool(server, ctx);
  registerSetupTools(server, ctx);
  registerSetupRunTools(server, ctx);
  registerSetupVersionTools(server, ctx);
  registerRunWebhookTools(server, ctx);
  registerSavedKeyTools(server, ctx);
  registerViewTools(server, ctx);
  registerTransferTool(server, ctx);
  registerTransformTool(server, ctx);
}
