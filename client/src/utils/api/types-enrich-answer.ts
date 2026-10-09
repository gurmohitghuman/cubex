// The answer panel's shapes, mirrored from server/src/services/answer-read.ts
// and lib/answer-steps.ts. Re-exported from './types'.

// Who answered, as treg's _treg.tier says: your own key, a free public route,
// or treg's own key.
export type AnswerAccess = 'own' | 'free' | 'treg'

export interface AnswerCallStep {
  attempt: string
  step: 'guess' | 'find' | 'check' | 'call'
  toolId: string
  callId: string | null
  costUsd: number | null
  originalCostUsd: number | null
  httpStatus: number | null
  tregError: string | null
  servedBy: string | null
  servedVia: string | null
  cached: boolean
  replay: boolean
  at: string
  email: string | null
  verdict: string | null
  word: string | null
  outcome: string | null
  // A find that returned an address this row already checked: that verdict.
  alreadyChecked: string | null
}

export interface AnswerTriedProvider {
  provider: string
  outcome: string
  status: number | null
  costUsd: number | null
  detail: string | null
}

export interface EnrichAnswerInfo {
  toolId: string
  toolName: string
  foundBy: string | null
  access: AnswerAccess | null
  costUsd: number | null
  sameLookup: boolean
  calls: AnswerCallStep[]
  tried: AnswerTriedProvider[]
}

export interface AnswerView {
  kind: 'enrichment' | 'http'
  column: string
  statusColumn: string
  rowIndex: number
  runId: string
  runAt: string
  status: 'completed' | 'failed'
  reason: string | null
  result: Array<{ column: string; value: string }>
  answer: unknown
  trimmed: string[]
  prunedAt: string | null
  mapping: Array<{ columnName: string; jsonPath: string }>
  enrichment: EnrichAnswerInfo | null
  // A list job: its results became rows in this sheet (sheetId null: deleted since).
  addsRowsTo?: { sheetId: string | null; name: string | null } | null
}

export interface AnswerFieldAdded { column: string; jobId: string }
