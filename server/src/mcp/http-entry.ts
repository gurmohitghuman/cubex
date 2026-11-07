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
  createMcpHandler, isJsonContentType, isLegacyRequest, ProtocolErrorCode, SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { AuthInfo, McpHandlerRequestOptions } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer } from './build-server';
import type { McpAuthCtx } from './tool-helpers';
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
// headers that disagree with the body): the client's mistake, answered with
// its error already, so not logged. An error with any other code (an internal
// -32603 included) or none is logged, redacted. The SDK's refusals that carry
// no code are named by their words (the -32020/-32602 checks, the 415).
const HEADER_MISMATCH = -32020; // the spec's HeaderMismatch; the SDK exports no name for it
const CLIENT_CAUSED = new Set<number>([
  HEADER_MISMATCH, ProtocolErrorCode.MissingRequiredClientCapability,
  ProtocolErrorCode.UnsupportedProtocolVersion, ProtocolErrorCode.InvalidRequest,
  ProtocolErrorCode.InvalidParams, ProtocolErrorCode.ParseError,
]);
export function reportMcpError(error: Error): void {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' ? CLIENT_CAUSED.has(code) : /^(Rejected |Unsupported Media Type)/.test(error.message)) {
    return;
  }
  console.error('MCP request error:', redactError(error));
}

// No responseMode: answers are one JSON body unless a tool sends progress or
// log messages first, and no Cubex tool does.
const modern = createMcpHandler(
  ({ authInfo }) => buildMcpServer(callerOf(authInfo)),
  { legacy: 'reject', onerror: reportMcpError },
);

async function legacy(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
  const server = buildMcpServer(callerOf(options?.authInfo));
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

// Every version Cubex speaks, newest first: 2026-07-28 with _meta, and the
// versions a client reaches with initialize.
const everyVersion = (modernOnes: string[]): string[] =>
  [...new Set([...modernOnes, ...SUPPORTED_PROTOCOL_VERSIONS])].sort().reverse();

// The SDK's -32022 lists only the versions a request with _meta can name, but
// a server MUST list every version it supports (basic/versioning). The status
// and the rest of the body stay as the SDK wrote them.
async function withEveryVersion(res: Response): Promise<Response> {
  if (res.status !== 400 || !isJsonContentType(res.headers.get('content-type'))) return res;
  type Refusal = { error?: { code?: unknown; data?: { supported?: string[] } } };
  const body = await res.clone().json().catch(() => null) as Refusal | null;
  const data = body?.error?.code === ProtocolErrorCode.UnsupportedProtocolVersion ? body.error.data : undefined;
  if (!Array.isArray(data?.supported)) return res;
  data.supported = everyVersion(data.supported);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
}

export const mcpEntry = {
  fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> =>
    (await isLegacyRequest(request, options?.parsedBody))
      ? legacy(request, options) : withEveryVersion(await modern.fetch(request, options)),
};

// Express face: reads req.auth (authInfoFor) and the parsed body, and stops
// writing when the client hangs up.
export const serveMcp = toNodeHandler(mcpEntry, { onerror: reportMcpError });
