// The MCP tools' input schemas, for the REST bodies that take the same
// arguments. The tools are registered once on a stand-in server that only
// keeps what registerTool was given (mcp/build-server.ts registerAllTools), so
// no tool file needs to export its schema.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools } from '../mcp/build-server';

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
// the document describing a body that no longer exists.
export function toolBody(tool: string, opts: ToolBodyOptions = {}): z.ZodObject {
  const shape = captured().get(tool);
  if (!shape) throw new Error(`openapi: no MCP tool named ${tool}`);
  for (const key of [...(opts.omit ?? []), ...(opts.pick ?? [])]) {
    if (!(key in shape)) throw new Error(`openapi: MCP tool ${tool} has no field ${key}`);
  }
  const kept: Shape = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (opts.omit?.includes(key) || (opts.pick && !opts.pick.includes(key))) continue;
    kept[key] = schema;
  }
  const body = z.object({ ...kept, ...opts.extend });
  return opts.strict ? body.strict() : body;
}
