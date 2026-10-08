// The run-start request built from the drawer's draft (pure), in the shape
// server/src/lib/enrich-run-input.ts parses.
import type { EnrichRunRequest } from '@/utils/api'
import type { EnrichDraft, RowsMode } from './draft'

export interface RunChoice {
  mode: RowsMode            // the effective mode (a gone filter or selection is "all")
  selectedRows: number[]
  test: boolean             // Run on 5 rows
  order: string[]           // provider order, the team's own keys and free routes first
  rowGeneration?: number    // fences selected rows against a sort elsewhere
}

// True when the next run adds to the column a run of this draft made.
export const continuing = (d: EnrichDraft) => !!d.continueColumn && d.continueColumn === d.columnName.trim()

export function runRequest(d: EnrichDraft, c: RunChoice): EnrichRunRequest | null {
  if (!d.card) return null
  return {
    toolId: d.card.id,
    preset: d.card.preset ?? null,
    columnName: d.columnName.trim(),
    continueColumn: continuing(d),
    inputs: Object.fromEntries(Object.entries(d.bindings).map(([name, b]) => [name, b.kind === 'column' ? { column: b.column } : { value: b.value }])),
    cleanDomains: d.cleanDomains,
    providerOrder: c.order,
    skipProviders: d.skipProviders,
    stopAtFirst: d.stopAtFirst,
    email: d.card.preset === 'verified_email' ? { accept: d.emailChecks.accept, guess: d.emailChecks.guess, pattern: d.emailChecks.pattern } : null,
    outputs: d.outputs.filter(o => o.enabled).map(o => ({ key: o.key, path: o.path, columnName: o.columnName.trim() })),
    rows: { mode: c.mode, test: c.test, ...(c.mode === 'selected' ? { rowIndexes: c.selectedRows } : {}) },
    conditions: d.conditions.map(x => ({ column: x.column, op: x.op, value: x.value })),
    maxCostPerRowUsd: d.maxCostPerRowUsd,
    spendLimitUsd: d.spendLimitUsd,
    fresh: d.fresh,
    ...(c.mode === 'selected' && c.rowGeneration !== undefined ? { rowGeneration: c.rowGeneration } : {}),
  }
}

// Columns a continuing run may reuse: its status column and its outputs.
export function reusableNames(d: EnrichDraft): Set<string> {
  if (!continuing(d)) return new Set()
  return new Set([d.columnName.trim(), ...d.outputs.filter(o => o.enabled).map(o => o.columnName.trim())])
}
