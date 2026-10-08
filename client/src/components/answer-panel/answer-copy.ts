// The answer panel's words (pure): who found it and on what key, what it cost,
// each step, the parts of an answer that weren't kept, and the diagnostics a
// user can send to support. Only what treg and the ledger recorded; plain
// copy, no em dashes, formatCost and plural.
import type { AnswerAccess, AnswerCallStep, AnswerTriedProvider, AnswerView } from '@/utils/api'
import { formatCost } from '../ai-modal/format'
import { plural } from '../../lib/utils'

const ACCESS: Record<AnswerAccess, string> = { own: 'your own key', free: 'a free route', treg: "treg's key" }

// "Found by Kitt on treg's key", or null when treg named no one.
export function foundLine(v: AnswerView): string | null {
  const e = v.enrichment
  if (!e?.foundBy) return null
  return `Found by ${e.foundBy}${e.access ? ` on ${ACCESS[e.access]}` : ''}`
}

// What the row's status cell says, without its mark ("No valid email found").
export function statusLine(v: AnswerView): string | null {
  const text = (v.result[0]?.value ?? '').replace(/^[^\p{L}\p{N}$]+/u, '').trim()
  return text || null
}

export function costLine(v: AnswerView): string | null {
  const e = v.enrichment
  if (!e) return null
  if (e.sameLookup) {
    return 'Same lookup as another row in this run, so it reused that answer: no call of its own, no cost.'
  }
  if (e.costUsd === null) return 'No cost was reported for this row.'
  if (e.costUsd === 0) return 'Nothing was taken from your treg balance for this row.'
  return `${formatCost(e.costUsd)} from your treg balance for this row.`
}

function callCost(c: AnswerCallStep): string {
  if (c.replay) return c.originalCostUsd ? `replayed, first charged ${formatCost(c.originalCostUsd)}` : 'replayed, free'
  if (c.costUsd === null) return 'no cost reported'
  if (c.costUsd === 0) return 'free'
  return formatCost(c.costUsd)
}

const said = (c: AnswerCallStep) => c.word ?? c.verdict

// One line per call, from the ledger and Cubex's own notes.
export function stepText(c: AnswerCallStep, toolName: string): string {
  const label = { guess: 'Guess check', find: 'Find', check: 'Check', call: toolName }[c.step]
  if (c.tregError) return `${label}: treg refused the call${c.tregError !== '1' ? ` (${c.tregError})` : ''}`
  if (c.httpStatus !== null && (c.httpStatus < 200 || c.httpStatus > 299)) {
    return `${label}: treg answered ${c.httpStatus}`
  }
  if (c.step === 'guess') {
    const checker = c.servedBy ? `, checked by ${c.servedBy}` : ', checked'
    return `Guess ${c.email ?? 'an address'}${checker}${said(c) ? `: ${said(c)}` : ''}`
  }
  if (c.step === 'find') {
    if (c.outcome === 'hit' && c.email) {
      const found = `Find: ${c.servedBy ?? 'a provider'} found ${c.email}`
      return c.alreadyChecked ? `${found} again, already checked (${c.alreadyChecked}), so no new check` : found
    }
    return `Find: ${c.outcome === 'capped' ? 'the row budget ran out' : 'no address found'}`
  }
  if (c.step === 'check') {
    return `Check ${c.email ?? 'the address'}: ${c.servedBy ?? 'the checker'} said ${said(c) ?? 'nothing'}`
  }
  return c.servedBy ? `${toolName}: answered by ${c.servedBy}` : `${toolName}: answered`
}

export function stepCost(c: AnswerCallStep): string {
  return [callCost(c), c.cached ? 'cached' : null, c.servedVia ? `via ${c.servedVia}` : null].filter(Boolean).join(', ')
}

const OUTCOME: Record<string, string> = { hit: 'found', miss: 'not found', skipped: 'skipped', error: 'error' }

export function triedText(t: AnswerTriedProvider): string {
  const outcome = OUTCOME[t.outcome] ?? t.outcome
  const detail = t.detail ? ` (${t.detail.replace(/\s+/g, ' ').trim().slice(0, 120)})` : ''
  return `${t.provider}: ${outcome}${t.status !== null && t.outcome === 'error' ? ` ${t.status}` : ''}${detail}`
}

export function triedCost(t: AnswerTriedProvider): string {
  return t.costUsd === null ? '' : t.costUsd === 0 ? 'free' : formatCost(t.costUsd)
}

// "raw.sources", "raw.items from item 4 on", "the whole answer".
export function droppedText(path: string): string {
  if (path === '$') return 'the whole answer'
  const tail = /\[(\d+):\]$/.exec(path)
  const base = path.replace(/\[\d+:\]$/, '').replace(/^\$\.?/, '') || 'the answer'
  return tail ? `${base} from item ${Number(tail[1]) + 1} on` : base
}

export function keptNotice(v: AnswerView): string | null {
  const parts: string[] = []
  if (v.trimmed.length) {
    const list = [...new Set(v.trimmed.map(droppedText))]
    parts.push(`Part of this answer was too big to keep: ${list.slice(0, 5).join(', ')}`
      + `${list.length > 5 ? ` and ${plural(list.length - 5, 'more part')}` : ''}.`)
  }
  if (v.prunedAt) {
    parts.push(`The provider's raw data was removed on ${v.prunedAt.slice(0, 10)} to save space. `
      + 'The result fields are still here.')
  }
  return parts.length ? `${parts.join(' ')} Those parts can't become columns.` : null
}

export function diagnostics(v: AnswerView, displayRow: number): string {
  const lines = [
    `Cubex ${v.kind === 'enrichment' ? 'enrichment' : 'HTTP API column'} diagnostics`,
    ...(v.enrichment ? [`Tool: ${v.enrichment.toolId} (${v.enrichment.toolName})`] : []),
    `Run: ${v.runId}`,
    `Row: ${displayRow}, column ${v.column}`,
    `Status: ${v.status}${v.reason ? `: ${v.reason}` : ''}`,
  ]
  const calls = v.enrichment?.calls ?? []
  if (calls.length) {
    lines.push('Calls:')
    for (const c of calls) {
      const error = c.tregError ? ` treg error ${c.tregError}` : ''
      const cost = c.costUsd !== null ? ` cost ${formatCost(c.costUsd)}` : ''
      lines.push(`  ${c.attempt} call ${c.callId ?? 'none'} HTTP ${c.httpStatus ?? '?'}${error}${cost}`)
    }
  }
  return lines.join('\n')
}
