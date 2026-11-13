// MCP over HTTP for one signed-in request, in either protocol era (docs/mcp.md
// "Protocol versions"). routes/mcp.ts runs the Origin guard, the token, the
// limiter and the body parser first, then hands the request to serveMcp.
//   2026-07-28: a request whose _meta names its protocol version. The SDK's
//     createMcpHandler checks that envelope and the MCP-Protocol-Version,
//     Mcp-Method and Mcp-Name headers, answers server/discover and puts
//     resultType, serverInfo and the cache fields on every answer.
//   2025-era (initialize, then plain requests): the stateless transport with
//     plain JSON answers that /mcp has always used, so those clients see no change.
// The SDK's own classifier (isLegacyRequest) picks the era, so this routing can
// never disagree with createMcpHandler's. Every request gets a fresh server
// closed over its caller (build-server.ts); the caller travels in
// authInfo.extra, which the SDK passes to the factory untouched.
import {
  createMcpHandler, isLegacyRequest, ProtocolErrorCode, WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { AuthInfo, McpHandlerRequestOptions, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer } from './build-server';
import type { McpAuthCtx } from './tool-helpers';
import { asTheSpecSays, BATCH_REFUSED, INTERNAL_ERROR, refusal, requestIdOf } from './http-answers';
import { redactError } from '../lib/redact';

const CALLER = 'cubex';

// The token's secret is never put here: nothing in the SDK reads it (Cubex
// registers no OAuth scope challenges), and the token was checked already.
export function authInfoFor(ctx: McpAuthCtx): AuthInfo {
  return { token: '', clientId: ctx.tokenId, scopes: [...ctx.scopes], extra: { [CALLER]: ctx } };
}

function callerOf(authInfo: AuthInfo | undefined): McpAuthCtx {
  const ctx = authInfo?.extra?.[CALLER] as McpAuthCtx | undefined;
  if (!ctx) throw new Error('MCP request without a signed-in token');
  return ctx;
}

// The SDK reports every request it refused (a version Cubex doesn't speak,
// headers that disagree with the body, a body that isn't one JSON-RPC message)
// and every stray message (a response or progress note for nothing Cubex
// sent): the client's mistake, answered already or needing no answer, so not
// logged. An error with any other code (an internal -32603 included) or none
// is logged, redacted: an answer the server failed to encode or send, a
// handler that threw. The SDK's refusals that carry no code are named by their
// words (the -32020/-32602 checks, the 2025-era transport's 400, 406, 413, 415).
const HEADER_MISMATCH = -32020; // the spec's HeaderMismatch; the SDK exports no name for it
const CLIENT_CAUSED = new Set<number>([
  HEADER_MISMATCH, ProtocolErrorCode.MissingRequiredClientCapability,
  ProtocolErrorCode.UnsupportedProtocolVersion, ProtocolErrorCode.InvalidRequest,
  ProtocolErrorCode.InvalidParams, ProtocolErrorCode.ParseError,
]);
const CLIENT_CAUSED_WORDS = new RegExp('^(Rejected |Unsupported Media Type|Not Acceptable|Payload Too Large'
  + '|Bad Request|Invalid Request|Parse error|Received a (response|progress notification) for an unknown )');
export function reportMcpError(error: Error): void {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' ? CLIENT_CAUSED.has(code) : CLIENT_CAUSED_WORDS.test(error.message)) return;
  console.error('MCP request error:', redactError(error));
}

// The server for one request. The SDK leaves its onerror unset, so an error
// inside the protocol layer (an answer it failed to encode or send, a
// notification handler that threw) would go unseen: reported here, redacted.
// Exported for tests/unit/mcp-http-refusals.test.ts.
export function serverFor(authInfo: AuthInfo | undefined): McpServer {
  const server = buildMcpServer(callerOf(authInfo));
  server.server.onerror = reportMcpError;
  return server;
}

// No responseMode: answers are one JSON body unless a tool sends progress or
// log messages first, and no Cubex tool does.
const modern = createMcpHandler(({ authInfo }) => serverFor(authInfo), { legacy: 'reject', onerror: reportMcpError });

async function legacy(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
  const server = serverFor(options?.authInfo);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // no sessions: the Bearer token is the identity
    enableJsonResponse: true, // one JSON body, which reverse proxies pass without buffering concerns
  });
  try {
    await server.connect(transport);
    // In JSON mode this resolves with the whole answer, so closing after it is safe.
    return await transport.handleRequest(request, options);
  } finally {
    await transport.close();
    await server.close();
  }
}

// The body as routes/mcp.ts parsed it; read here only when a caller hands on
// the raw request instead.
async function bodyOf(request: Request, options?: McpHandlerRequestOptions): Promise<unknown> {
  if (options?.parsedBody !== undefined || request.method !== 'POST') return options?.parsedBody;
  return request.clone().json().catch(() => undefined);
}

// A batch is refused before either era sees it: 2026-07-28 and 2025-06-18 say
// one message per POST (basic/transports), and the 2025-03-26 transport would
// otherwise run up to 100 tool calls on one rate-limited request. Every answer
// then goes through asTheSpecSays, and a throw anywhere below is logged
// (redacted) and answered with -32603 and the request's id.
export const mcpEntry = {
  fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
    const body = await bodyOf(request, options);
    if (Array.isArray(body)) return refusal(400, ProtocolErrorCode.InvalidRequest, BATCH_REFUSED);
    try {
      return await asTheSpecSays((await isLegacyRequest(request, options?.parsedBody))
        ? await legacy(request, options) : await modern.fetch(request, options));
    } catch (error) {
      reportMcpError(error instanceof Error ? error : new Error(String(error)));
      return refusal(500, ProtocolErrorCode.InternalError, INTERNAL_ERROR, requestIdOf(body));
    }
  },
};

// Express face: reads req.auth (authInfoFor) and the parsed body, and stops
// writing when the client hangs up.
export const serveMcp = toNodeHandler(mcpEntry, { onerror: reportMcpError });
