// Output columns and their names (pure): which of a tool's fields start
// selected, default names that don't clash, and the clash checks the server
// makes (lib/column-names.ts findColumnNameCollision: exact, any case, or the
// same /token, as "# Revenue" and "Revenue" are).
import type { EnrichToolDetail } from '@/utils/api'
import type { OutputPick } from './draft'
import { humanize, inputLabel } from './labels'
import { plural } from '../../lib/utils'

const token = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')

// The existing column a name clashes with, or null.
export function nameClash(name: string, existing: string[]): string | null {
  const lower = name.toLowerCase()
  const tok = token(name)
  return existing.find(c => c === name || c.toLowerCase() === lower || (!!tok && token(c) === tok)) ?? null
}

// "Email", then "Email 2", "Email 3"… whatever is free.
export function uniqueName(base: string, taken: string[]): string {
  if (!nameClash(base, taken)) return base
  for (let n = 2; ; n++) if (!nameClash(`${base} ${n}`, taken)) return `${base} ${n}`
}

// Who answered, read from treg's answer (_treg.served_by); offered on every waterfall.
const FOUND_BY = { key: 'found_by', path: '$._treg.served_by', label: 'Found by' }
// A waterfall's outputs that start selected, beyond the ones it always fills.
const MAX_DEFAULT_OUTPUTS = 6

function seeds(tool: EnrichToolDetail, preset: string | undefined, inputNames: Set<string>): Array<Omit<OutputPick, 'columnName'>> {
  if (preset === 'verified_email') {
    return [
      { key: 'email', path: '$.output.email', label: 'Work email', enabled: true },
      { key: 'email_status', path: null, label: 'Email status', enabled: true },
      { ...FOUND_BY, enabled: true },
      { key: 'checked_by', path: null, label: 'Checked by', enabled: false },
    ]
  }
  if (tool.kind === 'waterfall') {
    let on = 0
    const fields = tool.outputs.map(o => {
      // Fields the waterfall always fills, then the rest that don't just echo an input.
      const enabled = !!o.required || (!inputNames.has(o.field) && on < MAX_DEFAULT_OUTPUTS)
      if (enabled) on++
      return { key: o.field, path: o.path, label: inputLabel(o.field, tool.capability), enabled }
    })
    return [...fields, { ...FOUND_BY, enabled: false }]
  }
  // A single tool's fields come from its example answer; the user picks. A
  // nested field reads by its own name ("credits.jobCredits" → "Job credits")
  // unless two fields share that name.
  const last = (field: string) => field.split('.').pop() ?? field
  const seen = new Map<string, number>()
  for (const o of tool.outputs) seen.set(last(o.field), (seen.get(last(o.field)) ?? 0) + 1)
  return tool.outputs.map(o => ({
    key: o.field, path: o.path, enabled: false,
    label: (seen.get(last(o.field)) ?? 0) > 1 ? humanize(o.field) : inputLabel(last(o.field), tool.capability),
  }))
}

// A list job's fields outside its results: they may also fill this row.
export function rowFields(tool: EnrichToolDetail): EnrichToolDetail {
  const at = tool.list?.path
  return at ? { ...tool, outputs: tool.outputs.filter(o => o.path !== at && !o.path.startsWith(`${at}[`)) } : tool
}

// addsRows: a list job's own outputs all start off (its results are the point).
export function defaultOutputs(
  tool: EnrichToolDetail, preset: string | undefined, inputNames: Set<string>, existing: string[], statusColumn: string,
  addsRows = false,
): OutputPick[] {
  const taken = [...existing, statusColumn]
  const picks = addsRows ? seeds(rowFields(tool), undefined, inputNames).map(s => ({ ...s, enabled: false }))
    : seeds(tool, preset, inputNames)
  return picks.map(s => {
    const columnName = uniqueName(s.label, taken)
    taken.push(columnName)
    return { ...s, columnName }
  })
}

// The first naming problem, checked before anything runs: a missing or clashing
// name, two new columns with one name, or no room left in the sheet.
export function namesProblem(
  columnName: string, outputs: OutputPick[], existing: string[], room: number | null,
): string | null {
  const status = columnName.trim()
  if (!status) return 'Add a column name.'
  const names = [status, ...outputs.filter(o => o.enabled).map(o => o.columnName.trim())]
  for (const name of names) {
    if (!name) return 'Give every output column a name.'
    if (/["\\]/.test(name)) return `Column names can't contain " or \\ ("${name}").`
    if (!/[A-Za-z0-9]/.test(name)) return `"${name}" needs at least one letter or number.`
    const clash = nameClash(name, existing)
    if (clash) return `A column named ${clash} already exists. Pick another name.`
  }
  const dup = names.find((n, i) => names.findIndex(m => nameClash(n, [m])) !== i)
  if (dup) return `Two new columns are both named ${dup}. Pick another name.`
  if (room !== null && names.length > room) {
    return room <= 0
      ? 'This sheet has no room for more columns.'
      : `This sheet has room for ${plural(room, 'more column')}. Turn off some outputs.`
  }
  return null
}
