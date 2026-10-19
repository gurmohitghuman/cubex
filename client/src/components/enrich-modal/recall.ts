// "Edit enrichment" (pure): Set up opens with what the column was set up with
// (its newest run, server lib/enrich-run-recall.ts), laid over the defaults
// built for the tool (setup-defaults.ts), so the outputs keep the tool's labels
// and any provider treg added since shows up switched on. A recalled output the
// tool no longer returns is left out: the run would refuse it. Fields added
// from an answer ("Add as column") stay, after the tool's own, read by their path.
import type { EnrichRecalledChoices } from '@/utils/api'
import type { Condition, EnrichDraft, InputBinding, OutputPick } from './draft'
import type { ListDraft } from './list-draft'

// Outputs Cubex fills itself, matched by key; treg's own fields by path.
const CUBEX_KEYS = new Set(['email', 'email_status', 'found_by', 'checked_by'])

function recallOutputs(built: OutputPick[], r: EnrichRecalledChoices): OutputPick[] {
  // An answer field is never one of Cubex's own outputs (Email reads the
  // checked address, not the finder's raw one), even on the same path.
  const matches = (x: EnrichRecalledChoices['outputs'][number], o: OutputPick) => {
    if (x.fromAnswer) return !CUBEX_KEYS.has(o.key) && x.path === o.path
    return CUBEX_KEYS.has(x.key) && CUBEX_KEYS.has(o.key) ? x.key === o.key : x.path === o.path
  }
  const own = built.map(o => {
    const hit = r.outputs.find(x => matches(x, o))
    return hit ? { ...o, enabled: true, columnName: hit.columnName } : { ...o, enabled: false }
  })
  // A field added from an answer that the tool lists too is that output, ticked.
  const listed = new Set(built.filter(o => !CUBEX_KEYS.has(o.key)).map(o => o.path).filter(Boolean))
  const fromAnswer = r.outputs.filter(x => x.fromAnswer && x.path && !listed.has(x.path)).map((x, i) => ({
    // Unique, and within the run request's 200-character key.
    key: `answer${i}:${x.path}`.slice(0, 200), path: x.path, label: x.path!.replace(/^\$\.?/, ''), enabled: true,
    columnName: x.columnName, fromAnswer: true,
  }))
  return [...own, ...fromAnswer]
}

// The column's order first, then any provider it didn't list (treg added it since).
function recallOrder(built: string[], r: EnrichRecalledChoices): string[] {
  const known = new Set(built)
  const first = r.providerOrder.filter(p => known.has(p))
  return [...first, ...built.filter(p => !first.includes(p))]
}

// A list job's choices: its sheet, provider, results per row, copied columns
// and kept fields (the field list itself loads from the column's results).
function recallList(built: ListDraft | null | undefined, r: EnrichRecalledChoices): ListDraft | null {
  const l = r.list
  if (!l || !built) return built ?? null
  return {
    dest: 'sheetId' in l.dest ? { kind: 'sheet', sheetId: l.dest.sheetId } : { kind: 'new', name: l.dest.newSheetName },
    maxItems: l.maxItems, provider: l.provider, copy: l.copy.map(c => c.from),
    fields: l.fields ? l.fields.map(f => ({
      path: f.path, label: f.path.replace(/^\$\.?/, ''), enabled: true, columnName: f.columnName,
    })) : null,
    dedupePath: l.dedupePath,
  }
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
    runIf: r.runIf ?? '',
    maxCostPerRowUsd: r.maxCostPerRowUsd, spendLimitUsd: null,
    recall: null, list: recallList(built.list, r),
  }
}
