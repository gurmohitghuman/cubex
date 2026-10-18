// The words the Waterfall drawer shows about steps (pure). defaultPath
// mirrors server/src/lib/waterfall/result-type.ts defaultValuePath.
import type { EnrichToolCard, EnrichToolOutput } from '@/utils/api'
import type { CheckOutcome, ResultType, StepChoices, StepKind, StepOutcome } from '@/utils/api/waterfall'
import type { DraftInput, DraftStep } from './draft'

const FIELDS: Record<ResultType, string[]> = {
  email: ['email', 'work_email'], phone: ['phone', 'mobile_phone', 'phone_number'],
  domain: ['domain', 'company_domain', 'website'], linkedin_url: ['linkedin_url', 'linkedin'],
  url: ['url', 'website'], text: [],
}

export function defaultPath(type: ResultType, outputs: EnrichToolOutput[]): string | null {
  for (const want of FIELDS[type]) {
    const hit = outputs.find(o => (o.field.split('.').pop() ?? '').toLowerCase() === want)
    if (hit) return hit.field
  }
  return null
}

// A card as the step's tool: a Popular job's preset (the enrichment drawer's
// own loop, such as Verified work email) is the plain tool here, titled as
// the catalog titles a treg waterfall (its job's first words).
const EM_DASH = String.fromCharCode(0x2014)
export function asStepTool(c: EnrichToolCard): EnrichToolCard {
  if (!c.preset) return c
  const job = (c.capabilityDescription ?? '').split(EM_DASH)[0].split(';')[0].trim().replace(/\.$/, '')
  return { ...c, preset: undefined, title: job || c.name }
}

export function toolLine(c: EnrichToolCard): string {
  const kind = c.kind === 'waterfall' ? `${c.childCount ?? 0} providers in turn` : (c.providerName ?? c.provider)
  const price = c.price.usd === null ? (c.needsOwnKey ? 'your own provider key' : 'price varies')
    : c.price.type === 'free' ? 'free'
    : `$${c.price.usd.toFixed(4)}${c.price.type === 'per_success' ? ' a find' : ' a call'}`
  return `${kind} · ${price}`
}

export const KIND_LABEL: Record<StepKind, string> = {
  enrichment: 'Enrichment', ai: 'AI', http: 'HTTP API', formula: 'Formula', lookup: 'Lookup',
}

export function stepSummary(s: DraftStep): string {
  const c: StepChoices = s.choices
  if (c.kind === 'enrichment') return s.toolName ?? (c.toolId || 'Pick a tool')
  if (c.kind === 'ai') return c.prompt.trim() ? c.prompt.trim().slice(0, 80) : 'Write a prompt'
  if (c.kind === 'formula') return c.formula.trim() ? c.formula.trim().slice(0, 80) : 'Write a formula'
  if (c.kind === 'lookup') {
    if (!c.sheetId) return 'Pick a sheet'
    const where = s.sheetName === null ? 'a deleted sheet' : s.sheetName ?? 'another sheet'
    return c.returnColumn ? `${c.returnColumn} from ${where}` : `In ${where}`
  }
  return c.url.trim() ? `${c.method} ${c.url.trim()}`.slice(0, 80) : 'Give it a URL'
}

// What "answered by" shows when the label is left empty (the server's default
// for a lookup is its sheet's name; for the others, close to the summary).
export const labelHint = (s: DraftStep): string =>
  (s.choices.kind === 'lookup' ? s.sheetName || 'Lookup' : stepSummary(s))

// The inputs a step reads when it says nothing else: /key in a prompt,
// {{key}} in a request or a formula, the same names for a tool.
export function defaultNeeds(s: DraftStep, inputs: DraftInput[]): string {
  const c = s.choices
  const label = (k: string) => inputs.find(i => i.key === k)?.label ?? k
  if (c.kind === 'enrichment') return "what its tool needs (treg's rule)"
  if (c.kind === 'lookup') return c.inputKey ? label(c.inputKey) : 'the input it looks for'
  const text = c.kind === 'ai' ? c.prompt : c.kind === 'formula' ? c.formula
    : [c.url, c.body ?? '', ...Object.values(c.headers)].join(' ')
  const keys = inputs.map(i => i.key).filter(k => (c.kind === 'ai'
    ? new RegExp(`(^|[^/:\\w])/${k}\\b`).test(text) : text.includes(`{{${k}}}`)))
  return keys.length ? keys.map(label).join(' + ') : 'nothing'
}

export const OUTCOME_TEXT: Record<StepOutcome, string> = {
  answered: 'Answered', rejected: 'Rejected by its check', not_found: 'Found nothing', no_inputs: 'Skipped: no inputs',
  error: 'Failed', budget: 'Reached its cost cap',
}

export const FROM_TEXT = {
  journal: 'kept from before a pause', dry_run: 'from the dry run', reused: 'an earlier answer, reused at $0',
  same_lookup: 'the same request as another row',
  last_run: 'kept from its last run, not asked again',
} as const

export const pct = (n: number | null): string => (n === null ? 'unknown' : `${Math.round(n * 100)}%`)

const CHECK_TEXT = { passed: 'check passed', failed: 'check failed', error: "check couldn't run" } as const

// " · check passed (valid)" after a step's outcome, '' without a check.
export function checkText(c: CheckOutcome | undefined): string {
  if (!c) return ''
  return ` · ${CHECK_TEXT[c.outcome]}${c.verdict ? ` (${c.verdict})` : ''}${c.from ? `, ${FROM_TEXT[c.from]}` : ''}`
}
