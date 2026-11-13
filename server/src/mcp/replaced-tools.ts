// A call to a tool a release removed or renamed (mcp/agent-changes.ts) gets a tool error that says what
// replaced it, so an agent working from an older tool list (a client keeps tools/list for up to 5 minutes,
// and Cubex sends no list-changed notice) can go on. Any other unknown name stays the SDK's -32602.
// Installed through the Server's _wrapHandler hook, like the cursor check (list-cursor.ts): before any
// tool registers, so it runs in front of the SDK's own check of the tool name, in both eras.
import type { McpServer } from '@modelcontextprotocol/server';
import { replacedTools } from '../services/version-changes';
import { err } from './tool-helpers';

type Handler = (request: { params?: unknown }, ctx: unknown) => unknown;
type WithHook = { _wrapHandler: (method: string, handler: Handler) => Handler };

let fromFile: Map<string, string> | null = null;

export function answerReplacedTools(server: McpServer, replaced?: Map<string, string>): void {
  const answers = replaced ?? (fromFile ??= replacedTools());
  if (!answers.size) return;
  const inner = server.server as unknown as WithHook;
  if (typeof inner._wrapHandler !== 'function') throw new Error('The MCP SDK no longer has _wrapHandler');
  const wrap = inner._wrapHandler.bind(inner);
  inner._wrapHandler = (method, handler) => wrap(method, method !== 'tools/call' ? handler : (request, ctx) => {
    const name = (request.params as { name?: unknown } | undefined)?.name;
    const message = typeof name === 'string' ? answers.get(name) : undefined;
    return message ? err(message) : handler(request, ctx);
  });
}
