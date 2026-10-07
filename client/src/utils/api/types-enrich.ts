// Enrichment (treg.to) types for the Add enrichment drawer. Mirrors
// server/src/lib/enrich-tool*.ts, services/enrich-catalog.ts and
// services/enrich-setup.ts. Re-exported from './types'.
import type { EnrichDailyLimit } from './types-settings'

export interface EnrichToolPrice {
  type: string | null   // free | per_success | per_call | per_result
  unit: string | null
  usd: number | null
  varies: boolean
  note?: string
  overflowUsd: number | null
}

export interface EnrichToolObserved { okRate: number | null; hitRate: number | null; samples: number | null; hitSamples: number | null }

// A card in the Find step (Popular jobs or search results).
export interface EnrichToolCard {
  id: string
  name: string
  summary: string
  provider: string
  providerName?: string
  kind: 'waterfall' | 'single'
  capability: string | null
  capabilityDescription: string | null
  platformLabel: string | null
  price: EnrichToolPrice
  observed: EnrichToolObserved
  childCount: number | null
  needsOwnKey: boolean
  title: string
  blurb: string
  preset?: 'verified_email'
  addsRows: boolean
}

export interface EnrichToolInput {
  name: string
  in: 'query' | 'body' | 'path'
  type: string
  required: boolean
  note?: string
  example?: unknown
  enum?: unknown[]
  min?: number
  max?: number
  filter?: boolean   // a waterfall filter (country, limit…) rather than an identity key
}

export interface EnrichToolOutput { field: string; path: string; type?: string; note?: string; required?: boolean }

export interface EnrichToolProvider {
  endpointId: string
  provider: string
  name?: string
  usd: number | null
  hitRate: number | null
  usdPerHit: number | null
  works: number | null
  accepts: string[][]
  exhausted: boolean
  unavailable: 'async' | 'retired' | null
}

// One tool, for the Set up step.
export interface EnrichToolDetail extends Omit<EnrichToolCard, 'title' | 'blurb' | 'preset' | 'addsRows'> {
  method: string
  inputs: EnrichToolInput[]
  identitySets: string[][] | null
  derive: Record<string, string> | null
  outputs: EnrichToolOutput[]
  list: { field: string; path: string } | null
  providers: EnrichToolProvider[] | null
}

// How the user's treg team is served for a tool; plan rows are treg's.
export interface EnrichToolAccess {
  tier: string | null
  metered: boolean | null
  estimatedCostUsd: number | null
  plan: Array<Record<string, unknown>> | null
}

export interface EnrichSheetSetup {
  rows: { all: number; filter: number | null }   // filter: null when no filter is on
  columns: { count: number; max: number }
}

export interface EnrichEstimateRequest {
  toolId: string
  rows: number
  preset: 'verified_email' | null
  given: string[]
  skip: string[]
  order: string[]
  stopAtFirst: boolean
  maxCostPerRowUsd: number | null
}

export interface EnrichEstimate {
  estimate: { rows: number; lowUsd: number; highUsd: number; perRowLowUsd: number; perRowHighUsd: number }
  defaultMaxCostPerRowUsd: number
  providersOn: string[] | null
  // A waterfall that would call no provider (the figures are then 0).
  noProvider: boolean
  // false: no listed price (the tool runs on the team's own provider key).
  priceKnown: boolean
  dailyLimit: EnrichDailyLimit
}

export interface TregBalance { balanceUsd: number; onHoldUsd: number }
