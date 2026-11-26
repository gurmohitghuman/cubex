// Every tool guide get_tool_guide answers (services/tool-guide.ts), by tool, from the area files; guide.ts says
// what one holds. A tool with a guide ends its description with GUIDE_POINTER (tests/unit/mcp-tool-guide.test.ts).
import type { ToolName } from '../tool-outputs';
import type { ToolGuide } from './guide';
import { READ_GUIDES } from './read';
import { RUN_GUIDES } from './runs';
import { RUN_MANAGE_GUIDES } from './run-manage';
import { ENRICH_GUIDES } from './enrich';
import { FILL_GUIDES } from './fill';
import { SETUP_GUIDES } from './setups';
import { SETUP_CALL_GUIDES } from './setup-calls';
import { ACCOUNT_GUIDES } from './account';
import { STRUCTURE_GUIDES } from './structure';

export const TOOL_GUIDES: Partial<Record<ToolName, ToolGuide>> = {
  ...READ_GUIDES, ...RUN_GUIDES, ...RUN_MANAGE_GUIDES, ...ENRICH_GUIDES, ...FILL_GUIDES, ...SETUP_GUIDES,
  ...SETUP_CALL_GUIDES, ...ACCOUNT_GUIDES, ...STRUCTURE_GUIDES,
};
