// tools/list answers every tool at once and hands out no cursor, so a cursor
// sent to it is one Cubex never gave: refused with -32602, as the spec asks for
// an invalid cursor (server/utilities/pagination). McpServer installs its own
// tools/list handler when the first tool registers and has no hook in front of
// it, so this wraps the server's public setRequestHandler before any tool
// registers. The check then runs in front of the SDK's handler, after the SDK's
// request checks, for both protocol eras (one server serves both).
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';

export const INVALID_CURSOR = 'Invalid cursor: tools/list answers every tool at once and gives no cursor.';

type ListRequest = { params?: { cursor?: unknown } };

export function refuseToolListCursor(server: McpServer): void {
  const inner = server.server;
  const set = inner.setRequestHandler.bind(inner) as (method: string, ...rest: unknown[]) => void;
  inner.setRequestHandler = ((method: string, ...rest: unknown[]) => {
    const handler = rest[0];
    if (method !== 'tools/list' || rest.length !== 1 || typeof handler !== 'function') return set(method, ...rest);
    return set(method, (request: ListRequest, ctx: unknown) => {
      if (request.params?.cursor === undefined) return handler(request, ctx);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, INVALID_CURSOR);
    });
  }) as typeof inner.setRequestHandler;
}
