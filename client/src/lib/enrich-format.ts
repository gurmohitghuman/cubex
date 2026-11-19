// Shared wording for enrichment money and limits (Settings, estimate boxes,
// pause notices). Plain words, no em dashes.
import { formatCost } from '../components/ai-modal/format'

export const TREG_APP_URL = 'https://treg.to/app'
export const TREG_TOPUP_URL = 'https://treg.to/app#billing'


// A limit or balance: always cents.
export const usd = (value: number): string => `$${value.toFixed(2)}`

// A most, rounded up as the server's moneyUp is (server/src/lib/cost-ceiling.ts): cents from $1 up, two
// significant figures below, so it never reads as less than it is ($0.075, never $0.07; $0.011 for $0.0104).
export function moneyUp(value: number): string {
  if (value <= 0) return usd(value)
  const step = value >= 1 ? 0.01 : 10 ** (Math.floor(Math.log10(value)) - 1)
  const digits = value >= 1 ? 2 : Math.max(2, -Math.floor(Math.log10(step) + 1e-9))
  const [whole, frac] = (Math.ceil(value / step - 1e-9) * step).toFixed(digits).split('.')
  return `$${whole}.${frac.replace(/0+$/, '').padEnd(2, '0')}`
}

// What was spent: sub-cent amounts keep their digits (formatCost) so a few
// $0.003 calls never read as "$0.00 used".
export const spent = (value: number): string => (value === 0 ? '$0.00' : formatCost(value))

// A limit someone typed reads as typed, to the micro-dollar limits are kept in:
// $0.10, $0.0125, $0.005, $0.000001.
export const limitText = (value: number): string =>
  (Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? usd(value) : `$${value.toFixed(6).replace(/0+$/, '')}`)

// Daily limits reset at midnight UTC; say when that is for the reader.
export function utcMidnightLocal(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function resetsAtText(now = new Date()): string {
  return `resets at midnight UTC (${utcMidnightLocal(now)} your time)`
}
