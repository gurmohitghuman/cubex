// What a tool guide is (get_tool_guide, services/tool-guide.ts). tools/list is loaded by every client before the
// first call, so a long description is kept to what an agent needs to choose the tool and call it right, and ends
// with GUIDE_POINTER; the rest of what it said is the tool's guide, read when needed: the details in the order the
// description gave them, then the whole notes of each input field whose schema keeps one short line.
import { OVERSHOOT_NOTE } from '../../lib/token-spend';

export const GUIDE_POINTER = 'Details: get_tool_guide.';

export interface ToolGuide {
  // The details the description leaves out, a paragraph each.
  text: string[];
  // Input fields whose schema says one short line: each one's whole notes (the REST document shows these too).
  fields?: Record<string, string>;
  // A tool that starts or resumes paid runs: what happens at a token's spend cap (its description says the cap).
  spendCap?: true;
}

// The cap's own line stays in the description (lib/token-spend.ts capRunToolNote); the server instructions also
// carry this note whole when the token has a cap.
export const SPEND_CAP_GUIDE = `When this access token has a spend cap: ${OVERSHOOT_NOTE}`;

export function guideText(guide: ToolGuide): string {
  const parts = [...guide.text];
  const fields = Object.entries(guide.fields ?? {});
  if (fields.length) parts.push(['Fields:', ...fields.map(([name, notes]) => `- ${name}: ${notes}`)].join('\n'));
  if (guide.spendCap) parts.push(SPEND_CAP_GUIDE);
  return parts.join('\n\n');
}
