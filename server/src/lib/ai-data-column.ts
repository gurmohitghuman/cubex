// The "(Data)" citations column an AI run writes, or null when it has none. One
// place for the rule, used by locking, placeholder clearing, column types, the
// live stream and the results route:
//   - structured (multi-column) runs store theirs in ai_runs.data_column, set at
//     start when web search or web fetch is on (migration 006);
//   - a single-column run's is derived from its "(Output)" name and exists only
//     with web search (fetch returns no citations there).
export interface AiRunDataColumnFields {
  column_name: string;
  output_columns: string | null;
  data_column?: string | null;
  use_openrouter_web_search: number | boolean | null;
}

export function aiRunDataColumn(run: AiRunDataColumnFields): string | null {
  if (run.output_columns) return run.data_column || null;
  if (!run.use_openrouter_web_search) return null;
  return run.column_name.endsWith(' (Output)')
    ? run.column_name.replace(/ \(Output\)$/, ' (Data)')
    : `${run.column_name} (Data)`;
}
