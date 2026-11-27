// The MCP tools' input schemas, for the REST bodies that take the same
// arguments. The tools are registered once on a stand-in server that only
// keeps what registerTool was given (mcp/build-server.ts registerAllTools), so
// no tool file needs to export its schema.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools } from '../mcp/build-server';
import { TOOL_GUIDES } from '../mcp/guides';
import type { ToolName } from '../mcp/tool-outputs';

type Shape = Record<string, z.ZodType>;
let shapes: Map<string, Shape> | null = null;

function captured(): Map<string, Shape> {
  if (shapes) return shapes;
  const found = new Map<string, Shape>();
  const standIn = {
    registerTool(name: string, config: { inputSchema?: Shape | z.ZodType }) {
      const input = config.inputSchema ?? {};
      found.set(name, input instanceof z.ZodObject ? (input.shape as Shape) : input as Shape);
    },
  };
  const ctx = { userId: '', tokenId: '', tokenName: '', scopes: new Set<never>() };
  registerAllTools(standIn as unknown as McpServer, ctx);
  shapes = found;
  return found;
}

export interface ToolBodyOptions {
  // Path parameters and fields the REST route doesn't read.
  omit?: string[];
  // Or only these fields.
  pick?: string[];
  // Fields the REST route reads differently, or reads besides the tool's.
  extend?: Shape;
  // The route refuses fields it doesn't know (additionalProperties: false).
  strict?: boolean;
}

// A REST body built from an MCP tool's input schema. A field named in omit or
// pick that the tool doesn't have throws, so a renamed tool field can't leave
// the document describing a body that no longer exists. A field whose notes the
// tool list keeps to one line is described with its whole notes, from the
// tool's guide (mcp/guides).
export function toolBody(tool: string, opts: ToolBodyOptions = {}): z.ZodObject {
  const shape = captured().get(tool);
  if (!shape) throw new Error(`openapi: no MCP tool named ${tool}`);
  return bodyOf(tool, shape, opts);
}

// The same for one action of a tool that does several (fewer MCP tools): the action's own fields, as the tool file
// exports them (required where the action needs them), which the tool's schema is built from. The REST body stays
// what that action's old tool took.
export function actionBody(tool: string, shape: Shape, opts: ToolBodyOptions = {}): z.ZodObject {
  if (!captured().has(tool)) throw new Error(`openapi: no MCP tool named ${tool}`);
  return bodyOf(tool, shape, opts);
}

function bodyOf(tool: string, shape: Shape, opts: ToolBodyOptions): z.ZodObject {
  for (const key of [...(opts.omit ?? []), ...(opts.pick ?? [])]) {
    if (!(key in shape)) throw new Error(`openapi: MCP tool ${tool} has no field ${key}`);
  }
  const kept: Shape = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (opts.omit?.includes(key) || (opts.pick && !opts.pick.includes(key))) continue;
    const whole = TOOL_GUIDES[tool as ToolName]?.fields?.[key];
    kept[key] = whole ? schema.describe(whole) : schema;
  }
  const body = z.object({ ...kept, ...opts.extend });
  return opts.strict ? body.strict() : body;
}
