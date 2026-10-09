// "Add results as rows" (pure): a list job's part of the drawer's draft, its
// defaults, the request it sends (server lib/enrich-list-input.ts), the fields
// picked from real results, and what still stops a run. A list job asks one
// provider, and its fields come from results it actually returned (treg's
// catalog doesn't say what each provider's rows hold), so a new list column
// starts with a test on a few rows.
import type {
  EnrichListField, EnrichListFieldInfo, EnrichListRequest, EnrichToolDetail,
} from '@/utils/api'
import { MAX_SHEET_NAME_LENGTH } from '../../lib/constants'
import { humanize } from './labels'
import { nameClash, uniqueName } from './outputs'
import { providerCanAnswer } from './readiness'
import { providerRows, type ProviderRow } from './providers'
import type { InputBinding } from './draft'

export const LIST_DEFAULT_ITEMS = 10
export const LIST_MAX_ITEMS = 100
// Fields ticked at first: the ones the results fill, up to this many.
const DEFAULT_ON = 20

export type ListDest = { kind: 'new'; name: string } | { kind: 'sheet'; sheetId: string }
export interface ListFieldPick {
  path: string; label: string; enabled: boolean; columnName: string; filled?: number; sample?: string
}
export interface ListDraft {
  dest: ListDest
  maxItems: number
  provider: string | null          // a waterfall's one provider (slug)
  copy: string[]                   // source columns copied into each new row
  fields: ListFieldPick[] | null   // null: picked from the first results
  dedupePath: string | null        // '': "skip" ticked, no field picked yet
}

// "Results per row": 1 to 100, narrowed by the range treg declares for a
// tool's own limit input (the page size it's sent as).
export function perRowRange(tool: EnrichToolDetail): { min: number; max: number } {
  const lim = tool.inputs.find(i => i.name === 'limit')
  return {
    min: Math.max(1, Math.ceil(lim?.min ?? 1)), max: Math.min(LIST_MAX_ITEMS, Math.floor(lim?.max ?? LIST_MAX_ITEMS)),
  }
}
export function perRowProblem(maxItems: number, tool: EnrichToolDetail): string | null {
  const { min, max } = perRowRange(tool)
  return Number.isInteger(maxItems) && maxItems >= min && maxItems <= max ? null
    : `Results per row must be ${min} to ${max}.`
}

// A sheet of the table; `current` is the one the drawer runs on (never a destination).
export type SheetRef = { id: string; name: string; current?: boolean }

// The providers that can answer the inputs mapped, in treg's order.
export function listProviderRows(tool: EnrichToolDetail, sent: Set<string>): ProviderRow[] {
  const known = new Set(tool.inputs.map(i => i.name))
  return providerRows(tool.providers ?? [], null)
    .filter(r => !r.unavailable && !r.exhausted && providerCanAnswer(r.accepts, sent, tool.derive, known))
}

export function buildListDraft(
  tool: EnrichToolDetail, bindings: Record<string, InputBinding>, columns: string[], sheets: SheetRef[],
): ListDraft {
  const sent = new Set(Object.keys(bindings))
  const base = humanize(tool.list?.field ?? 'results')
  const bound = new Set(Object.values(bindings).flatMap(b => (b.kind === 'column' ? [b.column] : [])))
  return {
    dest: { kind: 'new', name: uniqueName(base, sheets.map(s => s.name)) },
    maxItems: Math.min(Math.max(LIST_DEFAULT_ITEMS, perRowRange(tool).min), perRowRange(tool).max),
    provider: tool.kind === 'waterfall' ? listProviderRows(tool, sent)[0]?.provider ?? null : null,
    copy: columns.filter(c => bound.has(c)),
    fields: null, dedupePath: null,
  }
}

export function listRequest(l: ListDraft): EnrichListRequest {
  const on = l.fields?.filter(f => f.enabled) ?? null
  return {
    dest: l.dest.kind === 'new' ? { newSheetName: l.dest.name.trim() } : { sheetId: l.dest.sheetId },
    provider: l.provider, maxItems: l.maxItems,
    fields: on && on.length ? on.map(f => ({ path: f.path, columnName: f.columnName.trim() })) : null,
    copy: l.copy.map(c => ({ from: c, to: c })),
    dedupePath: on?.some(f => f.path === l.dedupePath) ? l.dedupePath : null,
  }
}

// Fields to pick from the results: the ones kept already (Edit) ticked under
// their names, the rest offered; with none kept, the filled ones start ticked.
export function fieldPicks(
  found: EnrichListFieldInfo[], kept: EnrichListField[] | null, copy: string[],
): ListFieldPick[] {
  const taken = [...copy]
  const keptBy = new Map((kept ?? []).map(k => [k.path, k]))
  let on = 0
  const picks = found.map((f): ListFieldPick => {
    const k = keptBy.get(f.path)
    const enabled = kept ? !!k : f.filled > 0 && on++ < DEFAULT_ON
    const columnName = k?.columnName ?? uniqueName(humanize(f.label), taken)
    taken.push(columnName)
    return { path: f.path, label: f.label, enabled, columnName, filled: f.filled, sample: f.sample }
  })
  // A kept field the results no longer show stays (its rows may still have it).
  for (const k of kept ?? []) {
    if (!picks.some(p => p.path === k.path)) {
      picks.push({ path: k.path, label: k.path.replace(/^\$\.?/, ''), enabled: true, columnName: k.columnName })
    }
  }
  return picks
}

// New results' fields joined into the picks so far: picks keep the user's
// ticks and names (their counts refresh), new fields come in unticked. With no
// picks yet, the defaults (fieldPicks).
export function mergePicks(
  current: ListFieldPick[] | null, found: EnrichListFieldInfo[], kept: EnrichListField[] | null, copy: string[],
): ListFieldPick[] {
  if (!current) return fieldPicks(found, kept, copy)
  const by = new Map(found.map(f => [f.path, f]))
  const taken = [...copy, ...current.map(c => c.columnName)]
  const merged = current.map(c => {
    const f = by.get(c.path)
    return f ? { ...c, label: f.label, filled: f.filled, sample: f.sample } : c
  })
  for (const f of found) {
    if (merged.some(m => m.path === f.path)) continue
    const columnName = uniqueName(humanize(f.label), taken)
    taken.push(columnName)
    merged.push({ path: f.path, label: f.label, enabled: false, columnName, filled: f.filled, sample: f.sample })
  }
  return merged
}

const GONE = 'The sheet for the results was deleted. Pick another sheet.'

// The destination's problem, shown under its field.
export function destProblem(l: ListDraft, sheets: SheetRef[] | null): string | null {
  if (l.dest.kind === 'sheet') {
    const id = l.dest.sheetId
    return sheets && !sheets.some(s => s.id === id) ? GONE : null
  }
  const name = l.dest.name.trim()
  if (!name) return 'Name the new sheet for the results.'
  if (name.length > MAX_SHEET_NAME_LENGTH) return `Sheet names can be at most ${MAX_SHEET_NAME_LENGTH} characters.`
  if (/[<>"]/.test(name)) return 'Sheet names can\'t contain < > or ".'
  const clash = sheets?.find(s => s.name.toLowerCase() === name.toLowerCase())
  return clash ? `A sheet named "${clash.name}" already exists. Pick another name, or pick that sheet.` : null
}

const nameProblem = (name: string): string | null => {
  if (!name) return 'Give every kept field a column name.'
  if (/["\\]/.test(name)) return `Column names can't contain " or \\ ("${name}").`
  return /[A-Za-z0-9]/.test(name) ? null : `"${name}" needs at least one letter or number.`
}

// What stops a run of this list job, in plain words (null: nothing). A test
// may run before any field is picked; a full run needs them.
export function listProblem(
  l: ListDraft, tool: EnrichToolDetail, sent: Set<string>, sheets: SheetRef[] | null, test: boolean,
): string | null {
  const dest = destProblem(l, sheets)
  if (dest) return dest
  const perRow = perRowProblem(l.maxItems, tool)
  if (perRow) return perRow
  if (tool.kind === 'waterfall') {
    if (!l.provider) return 'Pick the provider whose results become rows.'
    if (!listProviderRows(tool, sent).some(r => r.provider.toLowerCase() === l.provider!.toLowerCase())) {
      return "That provider can't search with these inputs. Map other inputs or pick another provider."
    }
  }
  if (!test && !l.fields) return 'Run on a few rows first, then pick the fields to keep.'
  return l.fields ? fieldsProblem(l, test) : null
}

// What stops the kept fields: none kept (a full run), a name problem, two
// columns with one name, or "skip" ticked without its field.
export function fieldsProblem(l: ListDraft, test = false): string | null {
  const on = l.fields?.filter(f => f.enabled) ?? []
  if (!test && on.length === 0) return 'Keep at least one field.'
  const names = [...l.copy, ...on.map(f => f.columnName.trim())]
  for (const n of names) {
    const p = nameProblem(n)
    if (p) return p
  }
  const dup = names.find((n, i) => names.findIndex(m => nameClash(n, [m])) !== i)
  if (dup) return `Two columns of the new rows would be named ${dup}. Rename the field, or stop copying the column.`
  // Skip ticked: its field must be one kept (a field unticked since leaves it unpicked).
  return l.dedupePath !== null && on.length > 0 && !on.some(f => f.path === l.dedupePath)
    ? 'Pick the field that tells results apart, or untick Skip results already added.' : null
}
