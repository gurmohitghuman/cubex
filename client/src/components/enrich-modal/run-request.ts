// The run-start request built from the drawer's draft (pure), in the shape
// server/src/lib/enrich-run-input.ts parses.
import type { EnrichEstimate, EnrichReuseCount, EnrichRunRequest } from '@/utils/api'
import { plural } from '../../lib/utils'
import type { EnrichDraft, RowsMode, RowsStatus } from './draft'
import { listRequest } from './list-draft'

export interface RunChoice {
  mode: RowsMode            // the effective mode (a gone filter or selection is "all")
  selectedRows: number[]
  test: boolean             // Run on 5 rows
  order: string[]           // provider order, the team's own keys and free routes first
  rowGeneration?: number    // fences selected rows against a sort elsewhere
  // Which rows of a column a run already made; a new column takes every row.
  status?: RowsStatus
  // The run limit the confirm or the estimate showed (kept even if rows were
  // added since); undefined: the draft's own (null: sized at start).
  spendLimitUsd?: number | null
}

// True when the next run adds to the column a run of this draft made.
export const continuing = (d: EnrichDraft) => !!d.continueColumn && d.continueColumn === d.columnName.trim()

// The rows' status a run takes: the draft's choice on a continuing column.
export const runStatusOf = (d: EnrichDraft): RowsStatus => (continuing(d) ? d.rowsStatus : 'any')

// A test run takes the next rows not run yet: on rows already run (failed,
// without a result, all again) it would re-buy the same rows each time.
export const canTest = (d: EnrichDraft) => !continuing(d) || d.rowsStatus === 'not_enriched'

// "1,199 rows not enriched yet", "12 rows that failed", "all 40 rows again".
export function rowsPhrase(n: number, status: RowsStatus, continuing: boolean): string {
  if (!continuing) return plural(n, 'row')
  if (status === 'not_enriched') return `${plural(n, 'row')} not enriched yet`
  if (status === 'no_result') return `${plural(n, 'row')} without a result`
  if (status === 'failed') return `${plural(n, 'row')} that failed`
  return n === 1 ? 'the 1 row again' : `all ${n.toLocaleString()} rows again`
}

export function runRequest(d: EnrichDraft, c: RunChoice): EnrichRunRequest | null {
  if (!d.card) return null
  const binding = (b: EnrichDraft['bindings'][string]) =>
    (b.kind === 'column' ? { column: b.column } : { value: b.value })
  return {
    toolId: d.card.id,
    preset: d.card.preset ?? null,
    columnName: d.columnName.trim(),
    continueColumn: continuing(d),
    inputs: Object.fromEntries(Object.entries(d.bindings).map(([name, b]) => [name, binding(b)])),
    cleanDomains: d.cleanDomains,
    providerOrder: c.order,
    skipProviders: d.skipProviders,
    stopAtFirst: d.stopAtFirst,
    email: d.card.preset === 'verified_email'
      ? { accept: d.emailChecks.accept, guess: d.emailChecks.guess, pattern: d.emailChecks.pattern } : null,
    // A list job has no output columns here: its results become rows elsewhere.
    outputs: d.list ? [] : d.outputs.filter(o => o.enabled).map(o => ({
      key: o.key, path: o.path, columnName: o.columnName.trim(), ...(o.fromAnswer ? { fromAnswer: true } : {}),
    })),
    list: d.list ? listRequest(d.list) : null,
    rows: {
      mode: c.mode, status: c.status ?? runStatusOf(d), test: c.test,
      ...(c.mode === 'selected' ? { rowIndexes: c.selectedRows } : {}),
    },
    conditions: d.conditions.map(x => ({ column: x.column, op: x.op, value: x.value })),
    ...(d.runIf.trim() ? { runIf: d.runIf } : {}),
    maxCostPerRowUsd: d.maxCostPerRowUsd,
    spendLimitUsd: c.spendLimitUsd !== undefined ? c.spendLimitUsd : d.spendLimitUsd,
    fresh: d.fresh,
    ...(c.mode === 'selected' && c.rowGeneration !== undefined ? { rowGeneration: c.rowGeneration } : {}),
  }
}

// The run limit a full run shows and keeps: the one typed, else the estimate's
// high end. Rows that reuse found answers cost nothing, so with some reusing it
// keeps one row more (an answer can go stale before the run); never $0, which
// the start refuses: then it's sized at the start from the rows.
export function quotedLimit(p: {
  draft: Pick<EnrichDraft, 'spendLimitUsd'>; estimate: EnrichEstimate | null; unpriced: boolean
  reuse?: EnrichReuseCount | null
}): number | null {
  if (p.unpriced) return null
  if (p.draft.spendLimitUsd !== null) return p.draft.spendLimitUsd
  const est = p.estimate?.estimate
  if (!est) return null
  const quote = est.highUsd + ((p.reuse?.rows ?? 0) > 0 ? est.perRowHighUsd : 0)
  return quote > 0 ? quote : null
}

// Columns a continuing run may reuse: its status column and its outputs.
export function reusableNames(d: EnrichDraft): Set<string> {
  if (!continuing(d)) return new Set()
  if (d.list) return new Set([d.columnName.trim()])
  return new Set([d.columnName.trim(), ...d.outputs.filter(o => o.enabled).map(o => o.columnName.trim())])
}
