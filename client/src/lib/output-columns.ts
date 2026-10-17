// Output columns in the AI column dialog: one answer per row fills several
// typed columns (the server's structured run, services/ai-run-start-multi.ts).
// The checks the dialog shows before a preview; the server checks again.
import { MAX_OUTPUT_COLUMNS_PER_RUN } from './constants'

export type OutputColumnType = 'string' | 'number' | 'boolean'
export interface OutputColumnDraft { columnName: string; type: OutputColumnType; description: string }

export const OUTPUT_TYPE_LABELS: Record<OutputColumnType, string> = {
  string: 'Text', number: 'Number', boolean: 'Yes or no',
}

// A column's /reference without the slash, as the server makes it (lib/prompt.ts normalizeColumnName).
export const columnToken = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')

// What the request sends: trimmed names, in the server's shape.
export const outputColumnsBody = (outputs: OutputColumnDraft[]): OutputColumnDraft[] =>
  outputs.map(o => ({ columnName: o.columnName.trim(), type: o.type, description: o.description.trim() }))

// The first problem with the output columns, or '' when they can run. existing:
// the sheet's column names; columnName: the run's name, which makes "<name> (Status)".
export function outputColumnsError(outputs: OutputColumnDraft[], existing: string[], columnName: string): string {
  if (outputs.length === 0) return ''
  if (outputs.length > MAX_OUTPUT_COLUMNS_PER_RUN) {
    return `An AI column can fill at most ${MAX_OUTPUT_COLUMNS_PER_RUN} output columns.`
  }
  const own = [`${columnName.trim()} (Status)`, `${columnName.trim()} (Data)`]
  const seen = new Map<string, string>()
  for (const o of outputs) {
    const name = o.columnName.trim()
    if (!name) return 'Give every output column a name.'
    const token = columnToken(name)
    if (!token) return `"${name}" needs at least one letter A-Z or digit 0-9.`
    if (seen.has(token)) return `"${seen.get(token)}" and "${name}" would both be /${token}. Use different names.`
    seen.set(token, name)
    const clash = existing.find(c => c.toLowerCase() === name.toLowerCase() || columnToken(c) === token)
    if (clash) return `This sheet already has a column "${clash}". Pick another name for "${name}".`
    if (own.some(c => columnToken(c) === token)) return `"${name}" is the name of this run's own status column.`
  }
  return ''
}
