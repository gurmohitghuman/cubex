// Structured AI runs: one AI call per row fills several typed columns, plus a
// "(Status)" column (the run's column_name) and, with web search or fetch, a
// "(Data)" column. Mirrors server/src/lib/structured-run-owner.ts.

interface StructuredRunFields {
  output_columns?: string | null
  status_column?: string | null
  data_column?: string | null
}

// The typed column names in a run's output_columns JSON; [] if none or malformed.
export function outputColumnNames(run: StructuredRunFields): string[] {
  if (!run.output_columns) return []
  try {
    const specs = JSON.parse(run.output_columns) as Array<{ columnName?: unknown }>
    return Array.isArray(specs) ? specs.map(s => s?.columnName).filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

// Every column a structured run writes; [] for a single-column run. A deleted
// status column detaches the run (status_column null), so it owns nothing.
export function structuredRunColumns(run: StructuredRunFields): string[] {
  if (!run.output_columns || !run.status_column) return []
  return [run.status_column, ...outputColumnNames(run), ...(run.data_column ? [run.data_column] : [])]
}

export function structuredRunOwns(run: StructuredRunFields, column: string): boolean {
  return structuredRunColumns(run).includes(column)
}
