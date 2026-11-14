// Every MCP error says what went wrong and what to send next (docs/mcp.md "Errors"):
//   - a tool error (isError: true) for an unknown sheet, table, column, run or setup adds the close
//     matches and the tool that lists them (next-steps.ts);
//   - arguments that don't fit a tool's inputSchema, which the SDK refuses as a tool error in its schema
//     library's words, are said again in plain words: the field, what it takes and what was sent
//     (input-errors.ts);
//   - a tools/call that isn't one (arguments that aren't an object, no name), which the SDK refuses as a
//     JSON-RPC -32602 with the raw list of issues, keeps the code with plain words.
// Tool errors stay tool results and protocol errors stay JSON-RPC errors. Installed through the Server's
// _wrapHandler hook (as list-cursor.ts and replaced-tools.ts are), before any tool registers: the tool
// part runs after the SDK's request check and the replaced-tool answer, and the outer part around the
// SDK's request check, the only place its -32602 can be caught.
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { McpAuthCtx, ToolResult } from './tool-helpers';
import { withNextStep } from './next-steps';
import { plainArgumentErrors, plainRequestError } from './input-errors';

type Handler = (request: { params?: unknown }, ctx: unknown) => unknown;
type WithHook = { _wrapHandler: (method: string, handler: Handler) => Handler };

// Each server's tool input schemas, for saying a refusal again (registerTool fills it).
const inputSchemas = new WeakMap<McpServer, Map<string, z.ZodType>>();
export function rememberInputSchema(server: McpServer, name: string, schema: z.ZodType | undefined): void {
  if (!schema) return;
  if (!inputSchemas.has(server)) inputSchemas.set(server, new Map());
  inputSchemas.get(server)!.set(name, schema);
}

// The SDK's words before a refusal of a tool's arguments (validateToolInput); kept, so a client that reads
// them still does.
const refusedArguments = (tool: string) => `Input validation error: Invalid arguments for tool ${tool}: `;

const firstText = (result: ToolResult) => (result.content?.[0]?.type === 'text' ? result.content[0].text : null);
const withText = (result: ToolResult, text: string): ToolResult =>
  ({ ...result, content: [{ type: 'text', text }, ...result.content.slice(1)] });

// A tool error as the agent should get it; any other result as it was.
export function answered(
  userId: string, tool: string, args: unknown, result: ToolResult, schema?: z.ZodType,
): ToolResult {
  const text = result?.isError ? firstText(result) : null;
  if (text === null) return result;
  const prefix = refusedArguments(tool);
  if (text.startsWith(prefix)) {
    const plain = schema ? plainArgumentErrors(schema, args) : null;
    return plain ? withText(result, prefix + plain.join(' ')) : result;
  }
  let body: { error?: unknown } | null = null;
  try { body = JSON.parse(text); } catch { return result; }
  if (!body || typeof body !== 'object' || typeof body.error !== 'string') return result;
  const message = withNextStep(userId, args, body.error);
  if (message === body.error) return result;
  const out = withText(result, JSON.stringify({ ...body, error: message }));
  const structured = result.structuredContent as { error?: unknown } | undefined;
  return typeof structured?.error === 'string' ? { ...out, structuredContent: { ...structured, error: message } } : out;
}

// The SDK's -32602 for a request that isn't one, in plain words; anything else thrown as it was.
function plainly(error: unknown): unknown {
  if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.InvalidParams) return error;
  const plain = plainRequestError(error.message);
  return plain ? new ProtocolError(error.code, plain, error.data) : error;
}

export function answerErrorsWithNextSteps(server: McpServer, ctx: McpAuthCtx): void {
  const inner = server.server as unknown as WithHook;
  if (typeof inner._wrapHandler !== 'function') throw new Error('The MCP SDK no longer has _wrapHandler');
  const wrap = inner._wrapHandler.bind(inner);
  inner._wrapHandler = (method, handler) => {
    const tool: Handler = method !== 'tools/call' ? handler : async (request, mcp) => {
      const { name, arguments: args } = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
      const result = await handler(request, mcp) as ToolResult;
      if (typeof name !== 'string') return result;
      return answered(ctx.userId, name, args, result, inputSchemas.get(server)?.get(name));
    };
    const wrapped = wrap(method, tool);
    return async (request, mcp) => {
      try {
        return await wrapped(request, mcp);
      } catch (error) {
        throw plainly(error);
      }
    };
  };
}
