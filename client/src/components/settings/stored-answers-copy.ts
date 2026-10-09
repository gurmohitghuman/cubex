// Words for Settings' "Stored answers" line (pure, unit-tested).
import type { StoredAnswers } from '../../utils/api/types-enrich-run'

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB']

export function sizeText(bytes: number): string {
  let v = bytes
  let u = 0
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++ }
  if (u === 0) return `${bytes.toLocaleString()} ${bytes === 1 ? 'byte' : 'bytes'}`
  return `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} ${UNITS[u]}`
}

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

export function agoText(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${count(m, 'minute')} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${count(h, 'hour')} ago`
  return `${count(Math.round(h / 24), 'day')} ago`
}

// "1.2 GB in 12,345 answers, counted 5 minutes ago", or what the count is doing.
export function sizeLine(v: StoredAnswers, now = Date.now()): string {
  if (v.bytes === null || v.answers === null || v.countedAt === null) {
    return v.counting ? 'Counting…' : 'Not counted yet.'
  }
  if (v.answers === 0) return `None yet${v.counting ? ' (counting again…)' : ''}.`
  const when = v.counting ? 'counting again…' : `counted ${agoText(v.countedAt, now)}`
  return `${sizeText(v.bytes)} in ${count(v.answers, 'answer')}, ${when}`
}

// The last prune, in a sentence, or null.
export function pruneLine(v: StoredAnswers): string | null {
  const p = v.prune
  if (!p) return null
  if (p.status === 'running') {
    return `Pruning details older than ${v.pruneDays} days… ${count(p.pruned, 'answer')} so far.`
  }
  if (p.status === 'failed') return 'The last prune stopped on an error. Try again.'
  const on = new Date(p.endedAt ?? p.startedAt).toLocaleDateString()
  return p.pruned === 0 ? `Last prune on ${on}: nothing older than ${v.pruneDays} days had details left.`
    : `Last prune on ${on}: details removed from ${count(p.pruned, 'answer')}.`
}
