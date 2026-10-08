// The Add enrichment drawer's state for one sheet: the step, what was searched
// and picked, and every Set up choice. Kept per sheet while the page is open
// (useEnrichmentDraft), so closing and reopening resumes; a reload starts fresh.
// The run start reads the same shape (run-request.ts).
import type { EnrichRecalledChoices, EnrichRowsStatus, EnrichToolCard } from '@/utils/api'

// find → setup → test (after Run on 5 rows) or run (after a full run).
export type EnrichStep = 'find' | 'setup' | 'test' | 'run'

// An input reads a column, or a fixed value typed once for every row.
export type InputBinding = { kind: 'column'; column: string } | { kind: 'fixed'; value: string }

// One output column: `key` is the tool's field (or a preset's own output),
// `path` where it sits in treg's answer (null: Cubex works it out, such as
// the email status).
export interface OutputPick { key: string; path: string | null; label: string; enabled: boolean; columnName: string }

// Verified work email: which checker verdicts count as good enough
// (server/src/lib/enrich-email-status.ts names them safest/balanced/wide).
export type AcceptLevel = 'safest' | 'balanced' | 'wide'
export interface EmailChecks { accept: AcceptLevel; guess: boolean; pattern: string }

// "Only run if": the operators row-selection.ts applies.
export type ConditionOp = 'not_empty' | 'empty' | 'eq' | 'neq' | 'contains' | 'gt' | 'lt'
export interface Condition { column: string; op: ConditionOp; value: string }

export type RowsMode = 'all' | 'filter' | 'selected'
// On a column a run already made: which of its rows, by their status cell.
export type RowsStatus = EnrichRowsStatus

export interface RowCounts { all: number | null; filter: number | null; selected: number }

// The chosen mode, or all rows once its filter or selection is gone.
export function effectiveMode(mode: RowsMode, counts: RowCounts): RowsMode {
  if (mode === 'filter' && counts.filter === null) return 'all'
  if (mode === 'selected' && counts.selected === 0) return 'all'
  return mode
}

// The rows a run would take, for the chosen mode (null while counting).
export function rowsFor(mode: RowsMode, counts: RowCounts): number | null {
  const m = effectiveMode(mode, counts)
  return m === 'filter' ? counts.filter : m === 'selected' ? counts.selected : counts.all
}

export interface EnrichDraft {
  step: EnrichStep
  query: string
  card: EnrichToolCard | null
  // The tool the Set up defaults below were built for (null: not built yet).
  builtFor: string | null
  columnName: string
  bindings: Record<string, InputBinding>
  cleanDomains: boolean
  providerOrder: string[]
  skipProviders: string[]
  stopAtFirst: boolean
  emailChecks: EmailChecks
  outputs: OutputPick[]
  rowsMode: RowsMode
  conditions: Condition[]
  maxCostPerRowUsd: number | null   // null: the estimate's default
  spendLimitUsd: number | null      // null: the estimate's high end
  fresh: boolean
  // The status column a run already made from this draft: the next run adds to
  // it instead of making new columns, on the rows `rowsStatus` picks.
  continueColumn: string | null
  rowsStatus: RowsStatus
  // The run the Test or Run step follows, and whether it has ended.
  runId: string | null
  runEnded: boolean
  // "Edit enrichment": the column's choices, applied once the tool's details load.
  recall: EnrichRecalledChoices | null
}

export const EMAIL_PATTERNS = ['first.last', 'firstlast', 'first', 'flast', 'f.last', 'first_last'] as const

export function emptyDraft(): EnrichDraft {
  return {
    step: 'find', query: '', card: null, builtFor: null, columnName: '', bindings: {}, cleanDomains: true,
    providerOrder: [], skipProviders: [], stopAtFirst: false,
    emailChecks: { accept: 'safest', guess: true, pattern: 'first.last' },
    outputs: [], rowsMode: 'all', conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
    continueColumn: null, rowsStatus: 'not_enriched', runId: null, runEnded: false, recall: null,
  }
}

// Picking a tool starts Set up over: the same tool keeps what was set.
export function pickTool(draft: EnrichDraft, card: EnrichToolCard): EnrichDraft {
  if (draft.card?.id === card.id && draft.card.preset === card.preset) return { ...draft, card, step: 'setup' }
  return { ...emptyDraft(), query: draft.query, card, step: 'setup' }
}
