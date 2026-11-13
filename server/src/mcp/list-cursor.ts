// tools/list answers every tool at once and hands out no cursor, so a cursor
// sent to it is one Cubex never gave: refused with -32602, as the spec asks for
// an invalid cursor (server/utilities/pagination). Any value counts, null too.
// The check has to run before the SDK's own check of the request, which turns
// a cursor that isn't a string into -32603 with its raw validation text. So it
// goes in through the Server's _wrapHandler hook, which wraps each handler as
// it registers (after the SDK's checks are bundled into it, so in front of
// them), and the Server's own wrapping (the tools/list cache hint) still runs
// around it. Installed before any tool registers; one server serves both eras.
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';

export const INVALID_CURSOR = 'Invalid cursor: tools/list answers every tool at once and gives no cursor. '
  + 'Send tools/list without one.';

type Handler = (request: { params?: unknown }, ctx: unknown) => unknown;
type WithHook = { _wrapHandler: (method: string, handler: Handler) => Handler };

export function refuseToolListCursor(server: McpServer): void {
  const inner = server.server as unknown as WithHook;
  if (typeof inner._wrapHandler !== 'function') throw new Error('The MCP SDK no longer has _wrapHandler');
  const wrap = inner._wrapHandler.bind(inner);
  inner._wrapHandler = (method, handler) => wrap(method, method !== 'tools/list' ? handler : (request, ctx) => {
    const params = request.params;
    if (params && typeof params === 'object' && 'cursor' in params) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, INVALID_CURSOR);
    }
    return handler(request, ctx);
  });
}
