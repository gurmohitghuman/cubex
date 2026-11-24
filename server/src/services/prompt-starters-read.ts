// A sheet's prompt starters for agents and scripts: list_prompt_starters (mcp/tools-prompt-starters.ts) and REST
// GET /api/v1/sheets/:id/prompt-starters. Built from the sheet's columns (lib/prompt-starters.ts, the same list
// the app's AI column dialog shows), each as run_ai_column's arguments. Reads the column list only: no row.
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { normalizeColumnName } from '../lib/prompt';
import { promptStarters, starterRunArgs, type StarterId } from '../lib/prompt-starters';

export interface PromptStarterView {
  id: StarterId;
  label: string;
  // What it does, in one line.
  hint: string;
  // run_ai_column's arguments: column_name, prompt and, for a starter filling several columns, output_columns.
  run: ReturnType<typeof starterRunArgs>;
}

// The sheet's starters, or null when the sheet isn't the caller's or is in the trash.
export function sheetPromptStarters(userId: string, sheetId: string): PromptStarterView[] | null {
  if (!verifySheetOwnership(sheetId, userId)) return null;
  const columns = getSheetColumns(sheetId, userId, false)
    .map(name => ({ name, reference: `/${normalizeColumnName(name)}` }));
  return promptStarters(columns).map(s => ({ id: s.id, label: s.label, hint: s.hint, run: starterRunArgs(s) }));
}

export const STARTERS_NOTE = 'Fill in the [square brackets] in the prompt, or ask the user, before you run it with '
  + 'run_ai_column. Runs cost money: price one with estimate_only first.';
