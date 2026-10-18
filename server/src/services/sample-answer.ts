// What /api/v1 and MCP answer for a new sample table (services/sample-table.ts):
// what's in it, what was filled for free, the duplicate it holds, and the AI
// column that waits for the person's go-ahead, with the call that runs it.
import type { SampleTable } from './sample-table';

export function sampleAnswer(s: SampleTable, surface: 'rest' | 'mcp') {
  const d = s.duplicates;
  const run = surface === 'mcp'
    ? `run_ai_column with sheet_id, column_name "${s.ai.name}", this prompt and target_row_ids`
    : `POST /sheets/${s.sheetId}/ai-runs with column_name "${s.ai.name}", this prompt and target_row_ids`;
  return {
    table: { id: s.tableId, name: s.tableName },
    sheet: { id: s.sheetId, name: s.sheetName, row_count: s.rows },
    fictional: 'Sample data: every name, company, website and email is made up, and the websites and emails end '
      + 'in .example, so no row points at a real person or company. Say so when you show it to the user.',
    filled_free: s.filled,
    duplicates: d && {
      columns: d.keys.map(k => k.column), duplicate_rows: d.duplicateRows, rows_without_a_key: d.emptyKeyRows,
      groups: d.samples.map(g => ({ kept_row: g.kept.row, duplicate_rows: g.removed.map(r => r.row) })),
      note: `Found by a dry run, nothing removed. ${surface === 'mcp' ? 'remove_duplicates'
        : `POST /sheets/${s.sheetId}/remove-duplicates`} with dry_run false removes them (to the trash).`,
    },
    ai_column: {
      column: s.ai.column, ran: false, prompt: s.ai.prompt, model: s.ai.model, target_row_ids: s.ai.tryRowIds,
      next: `Set up, not run: it costs money on the user's OpenRouter key and model. Only after the user agrees, `
        + `call ${run} (the first ${s.ai.tryRowIds.length} rows)${s.ai.model ? '' : ' and a model they pick'}; `
        + `it fills "${s.ai.column}".`,
    },
    ...(s.problems.length ? { problems: s.problems } : {}),
  };
}
