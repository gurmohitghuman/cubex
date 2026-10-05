export function formatPricePerMillion(perTokenUsd: string): string {
  const n = parseFloat(perTokenUsd)
  if (!isFinite(n) || n === 0) return 'free'
  const perMillion = n * 1_000_000
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}/M`
  return `$${perMillion.toFixed(2)}/M`
}

export function formatContext(n: number): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ctx`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k ctx`
  return `${n} ctx`
}

// ---- Run cost estimate (preview → full run extrapolation) ------------------
// We have real token usage from the (up to 5) preview rows. Average per-row tokens,
// multiply by the full row count, and price it with the model's per-token rates.
// This is a deliberately ROUGH estimate shown before "Run All Rows" — the sample is
// tiny and per-row token use varies, so we present a RANGE with a buffer, not a point.

export interface RunCostEstimate {
  // Inclusive token/cost range for the whole run (low = sample mean, high = +buffer).
  tokensLow: number
  tokensHigh: number
  costLow: number
  costHigh: number
  totalRows: number
  sampledRows: number   // how many preview rows had usage data (the basis of the avg)
  isFree: boolean       // both prices 0 → no cost, only show token estimate
}

// Spread applied to the sample mean to form the high end of the range. Per-row token
// use (especially completions) varies a lot across rows and a 5-row sample is small,
// so the true cost commonly lands above the bare average — bias the headline upward.
const ESTIMATE_BUFFER = 1.3

export function estimateRunCost(
  rows: Array<{ error?: string; promptTokens?: number; completionTokens?: number }>,
  totalRows: number,
  pricing: { prompt: string; completion: string } | undefined,
): RunCostEstimate | null {
  // Only rows that actually returned usage count toward the average — errored rows
  // (or rows from a provider that didn't report usage) would drag the mean to 0.
  const withUsage = rows.filter(r => r.promptTokens != null || r.completionTokens != null)
  if (withUsage.length === 0 || totalRows <= 0) return null

  const sum = (sel: (r: typeof withUsage[number]) => number | undefined) =>
    withUsage.reduce((acc, r) => acc + (sel(r) || 0), 0)
  const avgPrompt = sum(r => r.promptTokens) / withUsage.length
  const avgCompletion = sum(r => r.completionTokens) / withUsage.length

  // Pricing must be PRESENT and parse to finite, non-negative numbers. If it's
  // missing or malformed we return null (no estimate) instead of defaulting to 0 —
  // a `|| 0` fallback would mislabel a paid model as "free" and hide real cost.
  if (!pricing) return null
  const promptPerToken = parseFloat(pricing.prompt)
  const completionPerToken = parseFloat(pricing.completion)
  if (!Number.isFinite(promptPerToken) || !Number.isFinite(completionPerToken)
    || promptPerToken < 0 || completionPerToken < 0) return null
  const isFree = promptPerToken === 0 && completionPerToken === 0

  const tokensLow = Math.round((avgPrompt + avgCompletion) * totalRows)
  const tokensHigh = Math.round(tokensLow * ESTIMATE_BUFFER)
  // Cost is priced per token-class (input vs output) since they differ, often ~4×.
  const costPerRow = avgPrompt * promptPerToken + avgCompletion * completionPerToken
  const costLow = costPerRow * totalRows
  const costHigh = costLow * ESTIMATE_BUFFER

  return { tokensLow, tokensHigh, costLow, costHigh, totalRows, sampledRows: withUsage.length, isFree }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return `${n}`
}

// Dollars with sensible precision: sub-cent shows 4 dp, otherwise 2.
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
