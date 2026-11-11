// Shared plumbing for Cubex's MCP tools. Every tool handler closes over the
// request's authenticated context (built per-request in routes/mcp.ts — the
// transport is stateless, the Bearer token is the identity) and returns its
// result as structuredContent, mirrored as JSON text for clients that only read
// text (the spec asks for both: modelcontextprotocol.io/specification/2026-07-28/server/tools).
import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { AccessTokenScope } from '../lib/access-token';
import { redactError } from '../lib/redact';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import type { SpendView } from '../lib/token-spend';
import { digitsAsNumber } from '../lib/digits-text';

// Option types that also take their value as text. An MCP client whose tool
// list was loaded before an option existed sends it as a string ("true", "2"),
// which a strict schema rejects. Clients still see a plain boolean or integer.
// lenientInt's `message`: the words for every value it refuses (a wrong type, a
// fraction, out of range), in place of the schema library's own.
export const lenientBoolean = () =>
  z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
export const lenientInt = (min: number, max: number, message?: string) =>
  z.preprocess(v => digitsAsNumber(v), z.number(message).int(message).min(min, message).max(max, message));

export interface McpAuthCtx {
  userId: string;
  // The access token's id: the key for MCP's per-token rate windows.
  tokenId: string;
  scopes: Set<AccessTokenScope>;
  tokenName: string;
  abortSignal?: AbortSignal;
  // Where one-time file links for this caller point (lib/file-links.ts linkBase).
  linkBase?: string;
  // The token's spend cap and spend when the request came in (null: no cap),
  // for the tools that spend to say (lib/token-spend.ts capToolNote).
  spend?: SpendView | null;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown; // SDK result type allows extra fields
}

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  // An object only: 2025-era clients take nothing else (2026-07-28 allows any JSON value).
  ...(data !== null && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}),
});

export const err = (message: string): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  isError: true,
});

// An error that also carries what the caller needs to go on (a cursor, a
// count), as structuredContent mirrored as text.
export const errWith = (message: string, extra: Record<string, unknown>): ToolResult => {
  const data = { error: message, ...extra };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true };
};

// Scope gate: null when allowed, an isError result naming the missing scope
// otherwise (so the agent can tell the user which token setting to change).
export function missingScope(ctx: McpAuthCtx, scope: AccessTokenScope): ToolResult | null {
  if (ctx.scopes.has(scope)) return null;
  return err(`This action requires the '${scope}' scope on your Cubex access token.`);
}

// A tool handler: the async callback the SDK invokes with the validated input
// and the request's context (its cancel signal: mcpReq.signal). The input stays
// loose (the SDK infers per-tool arg shapes from the zod inputSchema); the
// context is the SDK's own type, so a change in its shape fails the typecheck.
// registerTool requires an inputSchema: the SDK passes a tool without one only the context.
type ToolHandler = (args: any, mcp: ServerContext) => Promise<ToolResult>;

// Wrap a tool handler so an UNEXPECTED throw becomes a generic client error
// with the detail redacted-and-logged server-side — NOT leaked verbatim. The
// MCP SDK otherwise returns error.message straight to the caller (SQL text,
// jobs.db paths, library internals). Deliberate err(...) returns (validation,
// scope, not-found) are normal RETURN values and pass through untouched; the
// SDK's own zod input-validation runs BEFORE the handler, so it stays specific.
// This is the single choke point — always registered via registerTool below so
// no handler can be added unwrapped (19 sites would otherwise drift).
export function withToolErrors(handler: ToolHandler): ToolHandler;
export function withToolErrors(name: string, handler: ToolHandler): ToolHandler;
export function withToolErrors(nameOrHandler: string | ToolHandler, maybeHandler?: ToolHandler): ToolHandler {
  const name = typeof nameOrHandler === 'string' ? nameOrHandler : 'unknown';
  const handler = typeof nameOrHandler === 'string' ? maybeHandler! : nameOrHandler;
  return async (args, mcp): Promise<ToolResult> => {
    try {
      return await handler(args, mcp);
    } catch (e) {
      // redactError: redacts the stack AND bounds it to 1000 chars (house style —
      // an unbounded provider stack could be huge and echo a key/header).
      console.error(`MCP tool error (${name}):`, redactError(e));
      return err('Something went wrong handling that request. Please try again.');
    }
  };
}

// MANDATORY registration wrapper: use this instead of server.registerTool so
// every handler gets withToolErrors by construction. Same call shape as the
// SDK's registerTool (name, config, handler): the handler is wrapped, and a
// field list in `config` becomes an object schema; the rest passes as-is (the
// SDK's registerTool is heavily overloaded, so we don't try to reproduce its
// exact param type; it validates the config + inputSchema at registration, so
// a bad shape still fails loudly).
export function registerTool(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Record<string, unknown> | z.ZodTypeAny; [k: string]: unknown },
  handler: ToolHandler,
): void {
  // Title and behaviour hints come from one table (tool-annotations.ts); a tool
  // missing from it fails here, on the first request, instead of shipping
  // with the spec's "destructive" defaults.
  const hints = TOOL_ANNOTATIONS[name];
  if (!hints) throw new Error(`MCP tool ${name} has no entry in tool-annotations.ts`);
  const { title, ...annotations } = hints;
  // A field list becomes an object schema here, with Cubex's own zod: the SDK
  // only takes a bare field list through an overload it has deprecated.
  const { inputSchema, ...rest } = config;
  const schema = inputSchema === undefined || inputSchema instanceof z.ZodType
    ? inputSchema : z.object(inputSchema as z.ZodRawShape);
  server.registerTool(
    name, { title, annotations, ...rest, ...(schema ? { inputSchema: schema } : {}) } as never,
    withToolErrors(name, refuseWhileSheetBusy(name, handler)) as never,
  );
}

// The busy-sheet rule of the HTTP routes (lib/sheet-busy.ts), for tools: one
// that names a sheet busy sorting, importing or rewriting a column gets the
// reason back, except tools that only read, that append rows (appends land
// above the busy operation's reserved range) or that stop runs.
const RUNS_WHILE_SHEET_BUSY = new Set([
  'list_tables', 'get_sheet', 'read_rows', 'export_csv', 'list_models',
  'list_runs', 'get_run_status', 'get_run_results', 'append_rows', 'get_list_fields', 'get_usage',
  // Making a link doesn't touch the sheet; using it checks for busy then.
  'create_upload_link', 'create_download_link',
  // Only cancel_all names a sheet, and stopping its runs is allowed while it is
  // busy: a run still writing its placeholders is what holds it (as /runs/stop).
  'control_run',
]);

// With an idempotency_key, update_cells reads the ledger first: a replay
// writes nothing, and one that would write is refused there, in these words
// (services/rows-write-keyed.ts; the one-row form's patchRowById checks too).
const KEYED_RUNS_WHILE_SHEET_BUSY = new Set(['update_cells']);

export function refuseWhileSheetBusy(name: string, handler: ToolHandler): ToolHandler {
  if (RUNS_WHILE_SHEET_BUSY.has(name)) return handler;
  return async (args, mcp): Promise<ToolResult> => {
    const input = (args ?? {}) as Record<string, unknown>;
    if (KEYED_RUNS_WHILE_SHEET_BUSY.has(name) && typeof input.idempotency_key === 'string') return handler(args, mcp);
    for (const key of ['sheet_id', 'source_sheet_id', 'destination_sheet_id']) {
      const what = typeof input[key] === 'string' ? sheetBusyWith(input[key] as string) : null;
      if (what) return err(busyMessage(what));
    }
    return handler(args, mcp);
  };
}
