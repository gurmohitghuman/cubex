// Shared wording for enrichment money and limits (Settings, estimate boxes,
// pause notices). Plain words, no em dashes.
import { formatCost } from '../components/ai-modal/format'

export const TREG_APP_URL = 'https://treg.to/app'
export const TREG_TOPUP_URL = 'https://treg.to/app#billing'


// A limit or balance: always cents.
export const usd = (value: number): string => `$${value.toFixed(2)}`

// What was spent: sub-cent amounts keep their digits (formatCost) so a few
// $0.003 calls never read as "$0.00 used".
export const spent = (value: number): string => (value === 0 ? '$0.00' : formatCost(value))

// A limit someone typed reads as typed: $0.10, $0.0125, $0.005.
export const limitText = (value: number): string =>
  (Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? usd(value) : `$${value.toFixed(4).replace(/0+$/, '')}`)

// Daily limits reset at midnight UTC; say when that is for the reader.
export function utcMidnightLocal(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function resetsAtText(now = new Date()): string {
  return `resets at midnight UTC (${utcMidnightLocal(now)} your time)`
}
