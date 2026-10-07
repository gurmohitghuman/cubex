// Are the mapped inputs enough to run (pure)? Mirrors the server's
// lib/enrich-accepts.ts: treg derives some keys from others (full_name from
// first_name + last_name, domain from an email or website), a waterfall
// needs one complete identity set, and a waterfall provider answers only
// with an identity it accepts. tests/unit/enrich-setup-client.test.ts keeps
// the two in step.
import type { EnrichToolDetail } from '@/utils/api'
import type { InputBinding } from './draft'
import { inputLabel } from './labels'

type Derive = Record<string, string> | null

export function keyAvailable(key: string, sent: Set<string>, derive: Derive, known: Set<string>): boolean {
  if (sent.has(key)) return true
  const expr = derive?.[key]
  if (!expr) return false
  const refs = (expr.match(/[a-z_][a-z0-9_]*/g) ?? []).filter(r => r !== key && known.has(r))
  if (refs.length === 0) return false
  return /^\s*coalesce\s*\(/.test(expr) ? refs.some(r => sent.has(r)) : refs.every(r => sent.has(r))
}

export const setAvailable = (set: string[], sent: Set<string>, derive: Derive, known: Set<string>) =>
  set.every(k => keyAvailable(k, sent, derive, known))

export const providerCanAnswer = (accepts: string[][], sent: Set<string>, derive: Derive, known: Set<string>) =>
  accepts.length === 0 || accepts.some(set => setAvailable(set, sent, derive, known))

// Inputs that will carry a value: a column that's still in the sheet, or a
// fixed value that isn't blank.
export function boundInputs(bindings: Record<string, InputBinding>, columns: string[]): Set<string> {
  const have = new Set(columns)
  return new Set(Object.entries(bindings)
    .filter(([, b]) => (b.kind === 'column' ? have.has(b.column) : b.value.trim() !== ''))
    .map(([name]) => name))
}

const joinOr = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`

// "Full name + Company domain, or LinkedIn URL".
export function identityText(tool: EnrichToolDetail): string {
  return joinOr((tool.identitySets ?? []).map(set => set.map(k => inputLabel(k, tool.capability)).join(' + ')))
}

// The first thing stopping a run, in plain words, or null when the inputs are enough.
export function inputProblem(tool: EnrichToolDetail, bindings: Record<string, InputBinding>, columns: string[]): string | null {
  const have = new Set(columns)
  for (const [name, b] of Object.entries(bindings)) {
    if (b.kind === 'column' && !have.has(b.column)) {
      return `The column "${b.column}" isn't in this sheet anymore. Pick another for ${inputLabel(name, tool.capability)}.`
    }
  }
  const sent = boundInputs(bindings, columns)
  const known = new Set(tool.inputs.map(i => i.name))
  if (tool.identitySets && !tool.identitySets.some(set => setAvailable(set, sent, tool.derive, known))) {
    return `Pick columns for ${identityText(tool)}.`
  }
  const required = tool.inputs.find(i => i.required && !sent.has(i.name))
  return required ? `Pick a column for ${inputLabel(required.name, tool.capability)}.` : null
}
