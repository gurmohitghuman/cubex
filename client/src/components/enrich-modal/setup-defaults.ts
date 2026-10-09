// Where Set up starts for a picked tool (pure): inputs matched to the sheet's
// columns by name, treg's provider order, the default outputs and names.
import type { EnrichToolCard, EnrichToolDetail } from '@/utils/api'
import type { EnrichDraft, InputBinding } from './draft'
import { autoMatch, norm } from './labels'
import { defaultOutputs, uniqueName } from './outputs'
import { providerRows } from './providers'
import { buildListDraft, type SheetRef } from './list-draft'

// A job that adds rows searches for them: only what names a company is a safe
// guess there (a person's name or title would turn into the search itself).
const COMPANY_KEYS = new Set(['domain', 'companydomain', 'website', 'companywebsite', 'company', 'companyname'])

// `filled`: columns with a value in the rows the grid has loaded. An empty
// column is never auto-matched: it would count providers that need it (and
// their prices) for rows that can't send it. The user can still pick it.
export function autoBindings(
  tool: EnrichToolDetail, columns: string[], addsRows = false, filled: Set<string> | null = null,
): Record<string, InputBinding> {
  const usable = filled ? columns.filter(c => filled.has(c)) : columns
  const taken = new Set<string>()
  const bindings: Record<string, InputBinding> = {}
  // Identity keys before filters: they decide who can answer.
  const inputs = [...tool.inputs].sort((a, b) => Number(!!a.filter) - Number(!!b.filter))
  for (const input of inputs) {
    // A required input with one allowed value can only be that value.
    if (input.required && input.enum?.length === 1) {
      bindings[input.name] = { kind: 'fixed', value: String(input.enum[0]) }
      continue
    }
    // A page size is a price dial, never a column.
    if (input.name === 'limit') continue
    const companyName = input.name === 'name' && !!tool.capability?.startsWith('companies.')
    if (addsRows && !COMPANY_KEYS.has(norm(input.name)) && !companyName) continue
    const column = autoMatch(input.name, tool.capability, usable, taken)
    if (column) { bindings[input.name] = { kind: 'column', column }; taken.add(column) }
  }
  return bindings
}

// A list job (its results become rows elsewhere) starts its "Add results as
// rows" part instead of outputs; `sheets` are the table's other sheets.
export function buildSetup(
  card: EnrichToolCard, tool: EnrichToolDetail, columns: string[], filled: Set<string> | null = null,
  sheets: SheetRef[] = [],
): Partial<EnrichDraft> {
  const columnName = uniqueName(card.title, columns)
  const inputNames = new Set(tool.inputs.map(i => i.name))
  const addsRows = tool.addsRows ?? card.addsRows
  const bindings = autoBindings(tool, columns, addsRows, filled)
  return {
    builtFor: tool.id,
    columnName,
    bindings,
    providerOrder: tool.providers ? providerRows(tool.providers, null).map(r => r.provider) : [],
    skipProviders: [],
    outputs: addsRows ? [] : defaultOutputs(tool, card.preset, inputNames, columns, columnName),
    list: addsRows ? buildListDraft(tool, bindings, columns, sheets) : null,
  }
}
