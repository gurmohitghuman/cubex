// Enrichment run shapes, mirrored from server/src/lib/enrich-run-input.ts and
// services/enrich-run-status.ts. Re-exported from './types'.

export type EnrichRunBinding = { column: string } | { value: string }

export interface EnrichRunRequest {
  toolId: string
  preset: 'verified_email' | null
  columnName: string
  // Add to an enrichment column a run already made (rows not enriched yet).
  continueColumn: boolean
  inputs: Record<string, EnrichRunBinding>
  cleanDomains: boolean
  providerOrder: string[]
  skipProviders: string[]
  stopAtFirst: boolean
  email: { accept: 'safest' | 'balanced' | 'wide'; guess: boolean; pattern: string } | null
  outputs: Array<{ key: string; path: string | null; columnName: string }>
  rows: { mode: 'all' | 'filter' | 'selected' | 'not_enriched'; test: boolean; rowIndexes?: number[] }
  conditions: Array<{ column: string; op: string; value: string }>
  maxCostPerRowUsd: number | null
  spendLimitUsd: number | null
  fresh: boolean
  // The sheet's row_generation when rows were selected (a sort since: 409).
  rowGeneration?: number
}

export interface EnrichRunStarted { runId: string; statusColumn: string; outputColumns: string[] }

export interface EnrichRunStatus {
  id: string
  status: string
  pauseReason: string | null
  message: string | null
  statusColumn: string | null
  toolName: string
  preset: string | null
  totalRows: number
  processedRows: number
  skippedRows: number
  rows: { completed: number; failed: number }
  spentUsd: number
  spendLimitUsd: number | null
  maxCostPerRowUsd: number | null
  dailyLimit: { limitUsd: number | null; usedTodayUsd: number; remainingUsd: number | null }
}
