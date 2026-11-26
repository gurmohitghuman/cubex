// get_tool_guide (mcp/tools-guide.ts): the details a tool's description in tools/list leaves out, from its guide
// (mcp/guides); without a tool, the tools that have one. A name that is no tool gets the close ones.
import { closeMatches } from '../lib/close-matches';
import { TOOL_ANNOTATIONS } from '../mcp/tool-annotations';
import { TOOL_GUIDES } from '../mcp/guides';
import { guideText } from '../mcp/guides/guide';
import type { ToolName } from '../mcp/tool-outputs';

export type ToolGuideAnswer = { tool: string; guide: string } | { tools: string[] };

export function toolGuide(tool: string | undefined): { ok: ToolGuideAnswer } | { error: string } {
  if (tool === undefined) return { ok: { tools: Object.keys(TOOL_GUIDES).sort() } };
  const name = tool.trim();
  const guide = Object.prototype.hasOwnProperty.call(TOOL_GUIDES, name) ? TOOL_GUIDES[name as ToolName] : undefined;
  if (guide) return { ok: { tool: name, guide: guideText(guide) } };
  if (Object.prototype.hasOwnProperty.call(TOOL_ANNOTATIONS, name)) {
    return { ok: { tool: name, guide: `${name} has no guide: its description in the tool list says it all.` } };
  }
  const shown = JSON.stringify(name.length > 60 ? `${name.slice(0, 57)}...` : name);
  const close = closeMatches(name, Object.keys(TOOL_ANNOTATIONS), n => [n]);
  return { error: `No tool is named ${shown}.${close.length ? ` Close matches: ${close.join(', ')}.` : ''} `
    + 'get_tool_guide without tool lists the tools that have a guide.' };
}
