// Settings / OpenRouter / API-key types, split out of types.ts (200-line
// guardrail). Re-exported from './types' — import sites don't need to know
// about the physical split.

// One daily limit for everything enrichments spend (UTC day). limitUsd null = off.
export interface EnrichDailyLimit {
  limitUsd: number | null
  usedTodayUsd: number
  remainingUsd: number | null
}

// How many days a found enrichment answer is reused before a row calls again (0: off).
export interface EnrichReuseSetting {
  days: number
  maxDays: number
}

export interface TregKeyTestResult {
  valid: boolean
  message: string
  problem?: 'invalid' | 'personal_token' | 'team_setup' | 'suspended' | 'unreachable' | 'unknown'
  team?: string | null
  balanceUsd?: number | null
  onHoldUsd?: number | null
}

export interface Settings {
  id: string | null
  hasOpenRouterKey: boolean
  // treg.to key for enrichments (stored encrypted; never sent to the browser).
  hasTregKey: boolean
  enrichDailyLimit: EnrichDailyLimit
  // Account-wide default AI model. Sheet defaults override it; with neither
  // set, AI runs are blocked until the user picks a model (no hardcoded fallback).
  defaultAiModel: string | null
  created_at: string | null
  updated_at: string | null
}

export interface OpenRouterModel {
  id: string
  name: string
  description?: string
  context_length: number
  pricing: { prompt: string; completion: string }
}

export interface OpenRouterKeyTestResult {
  valid: boolean
  message: string
  credits?: { usage?: number; limit: number | null; isFreeTier?: boolean; balance?: number }
}

export interface APIKey {
  id: string
  name: string
  key_type: 'bearer' | 'api_key' | 'custom'
  key_value?: string // Only included when creating/updating
  description?: string
  created_at: string
  updated_at: string
}

export interface APIKeySuggestion {
  name: string
  reference: string
  type: 'api_key'
  key_type: 'bearer' | 'api_key' | 'custom'
  description?: string
}

// Personal access tokens — programmatic /api/v1 (and future MCP) credentials.
// Distinct from APIKey above (third-party keys for HTTP enrichment templates).
export type AccessTokenScope = 'read' | 'write' | 'run' | 'secrets'

// What a token's runs, previews and AI helpers spent (AI + enrichments), and
// its lifetime cap (null: none). left_usd is null without a cap.
export interface TokenSpend {
  spend_cap_usd: number | null
  spent_usd: number
  left_usd: number | null
}

export interface AccessToken {
  id: string
  name: string
  token_prefix: string
  scopes: string // stored comma-set, e.g. "read,write,run"
  expires_at: string | null
  created_at: string
  last_used_at: string | null
  spend: TokenSpend
}

// POST response — carries the full token EXACTLY ONCE; never retrievable again.
export interface CreatedAccessToken extends AccessToken {
  token: string
}
