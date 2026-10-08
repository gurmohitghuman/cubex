// "Edit enrichment" (pure): Set up opens with what the column was set up with
// (its newest run, server lib/enrich-run-recall.ts), laid over the defaults
// built for the tool (setup-defaults.ts), so the outputs keep the tool's labels
// and any provider treg added since shows up switched on. A recalled output the
// tool no longer returns is left out: the run would refuse it.
import type { EnrichRecalledChoices } from '@/utils/api'
import type { Condition, EnrichDraft, InputBinding, OutputPick } from './draft'

// Outputs Cubex fills itself, matched by key; treg's own fields by path.
const CUBEX_KEYS = new Set(['email', 'email_status', 'found_by', 'checked_by'])

function recallOutputs(built: OutputPick[], r: EnrichRecalledChoices): OutputPick[] {
  return built.map(o => {
    const hit = r.outputs.find(x =>
      (CUBEX_KEYS.has(x.key) && CUBEX_KEYS.has(o.key) ? x.key === o.key : x.path === o.path))
    return hit ? { ...o, enabled: true, columnName: hit.columnName } : { ...o, enabled: false }
  })
}

// The column's order first, then any provider it didn't list (treg added it since).
function recallOrder(built: string[], r: EnrichRecalledChoices): string[] {
  const known = new Set(built)
  const first = r.providerOrder.filter(p => known.has(p))
  return [...first, ...built.filter(p => !first.includes(p))]
}

export function applyRecall(
  built: Partial<EnrichDraft>, r: EnrichRecalledChoices, column: string,
): Partial<EnrichDraft> {
  const bindings: Record<string, InputBinding> = {}
  for (const [name, b] of Object.entries(r.inputs)) {
    bindings[name] = 'column' in b ? { kind: 'column', column: b.column } : { kind: 'fixed', value: b.value }
  }
  return {
    ...built,
    columnName: column, continueColumn: column, rowsStatus: 'not_enriched',
    bindings, cleanDomains: r.cleanDomains, stopAtFirst: r.stopAtFirst, fresh: r.fresh,
    providerOrder: recallOrder(built.providerOrder ?? [], r), skipProviders: [...r.skipProviders],
    ...(r.email ? { emailChecks: { accept: r.email.accept, guess: r.email.guess, pattern: r.email.pattern } } : {}),
    outputs: recallOutputs(built.outputs ?? [], r),
    conditions: r.conditions.map(c => ({ column: c.column, op: c.op as Condition['op'], value: c.value })),
    maxCostPerRowUsd: r.maxCostPerRowUsd, spendLimitUsd: null,
    recall: null,
  }
}
