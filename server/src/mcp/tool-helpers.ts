// Shared plumbing for Cubex's MCP tools. Every tool handler closes over the
// request's authenticated context (built per-request in routes/mcp.ts — the
// transport is stateless, the Bearer token is the identity) and returns its
// result as structuredContent, mirrored as JSON text for clients that only read
// text (the spec asks for both: modelcontextprotocol.io/specification/2025-11-25/server/tools).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccessTokenScope } from '../lib/access-token';
import { redactError } from '../lib/redact';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { TOOL_ANNOTATIONS } from './tool-annotations';

// The row-filter condition every `where`-taking tool accepts (read_rows,
// transfer_rows, transform_column, export_csv). ONE definition: it was copied
// into three files, and a fourth copy for export_csv is how the surfaces start
// disagreeing about what `where` means. Backed by services/row-selection.ts.
// gt/gte/lt/lte compare NUMERICALLY: the value must parse as a number, and a
// cell that doesn't parse as one never matches (no lexicographic fallback).
export const rowConditionSchema = z.object({
  column: z.string(),
  operator: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'gte', 'lt', 'lte']),
  value: z.string().optional(),
});

export interface McpAuthCtx {
  userId: string;
  // The access token's id: the key for MCP's per-token rate windows.
  tokenId: string;
  scopes: Set<AccessTokenScope>;
  tokenName: string;
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown; // SDK result type allows extra fields
}

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  // structuredContent must be a JSON object.
  ...(data !== null && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}),
});

export const err = (message: string): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  isError: true,
});

// Scope gate: null when allowed, an isError result naming the missing scope
// otherwise (so the agent can tell the user which token setting to change).
export function missingScope(ctx: McpAuthCtx, scope: AccessTokenScope): ToolResult | null {
  if (ctx.scopes.has(scope)) return null;
  return err(`This action requires the '${scope}' scope on your Cubex access token.`);
}

// A tool handler: the async callback the SDK invokes with validated input.
// Loosely typed (the SDK infers per-tool arg shapes from the zod inputSchema);
// what matters here is that it resolves to a ToolResult.
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

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
  return async (...args: any[]): Promise<ToolResult> => {
    try {
      return await handler(...args);
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
// SDK's registerTool (name, config, handler) — only the handler is wrapped.
// `config` is passed through as-is (the SDK's registerTool is heavily
// overloaded, so we don't try to reproduce its exact param type — it validates
// the config + inputSchema at registration; a bad shape still fails loudly).
export function registerTool(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema?: Record<string, unknown>; [k: string]: unknown },
  handler: ToolHandler,
): void {
  // Title and behaviour hints come from one table (tool-annotations.ts); a tool
  // missing from it fails here, on the first request, instead of shipping
  // with the spec's "destructive" defaults.
  const hints = TOOL_ANNOTATIONS[name];
  if (!hints) throw new Error(`MCP tool ${name} has no entry in tool-annotations.ts`);
  const { title, ...annotations } = hints;
  server.registerTool(
    name, { title, annotations, ...config } as never,
    withToolErrors(name, refuseWhileSheetBusy(name, handler)) as never,
  );
}

// The busy-sheet rule of the HTTP routes (lib/sheet-busy.ts), for tools: one
// that names a sheet busy sorting, importing or rewriting a column gets the
// reason back, except tools that only read or that append rows (appends land
// above the busy operation's reserved range).
const RUNS_WHILE_SHEET_BUSY = new Set([
  'list_tables', 'get_sheet', 'read_rows', 'export_csv', 'list_models',
  'list_runs', 'get_run_status', 'get_run_results', 'append_rows',
]);

function refuseWhileSheetBusy(name: string, handler: ToolHandler): ToolHandler {
  if (RUNS_WHILE_SHEET_BUSY.has(name)) return handler;
  return async (...args: any[]): Promise<ToolResult> => {
    const input = (args[0] ?? {}) as Record<string, unknown>;
    for (const key of ['sheet_id', 'source_sheet_id', 'destination_sheet_id']) {
      const what = typeof input[key] === 'string' ? sheetBusyWith(input[key] as string) : null;
      if (what) return err(busyMessage(what));
    }
    return handler(...args);
  };
}
