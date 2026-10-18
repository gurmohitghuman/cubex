// The Waterfall drawer's draft (pure): the result type, the inputs mapped
// once to the sheet's columns, the ordered steps and the options, and the
// start request built from it. The result types and their starting inputs
// mirror server/src/lib/waterfall/result-type.ts.
import type {
  CheckChoices, InputSource, ResultType, RowsStatus, StepChoices, StepKind, WaterfallRunInput, WaterfallSetup,
} from '@/utils/api/waterfall'

export interface DraftInput { key: string; label: string; source: InputSource | null }
export interface DraftStep {
  key: string                    // React key (the step's id)
  id: string | null              // a new step's is made here (so Test can name it before any run)
  label: string                  // '' = named by the server (tool name, "AI", the API's host)
  on: boolean
  requires: string[][] | null    // null = what the step reads (or its tool's rule)
  choices: StepChoices
  check: CheckChoices | null     // a check on the value it finds
  toolName?: string              // an enrichment step's tool, as its card shows it
}
export interface WaterfallDraft {
  columnName: string
  continueColumn: boolean
  resultType: ResultType
  phoneFormat: 'national' | 'international' | 'e164'
  phoneCountry: string
  inputs: DraftInput[]
  steps: DraftStep[]
  answeredBy: boolean
  hideStepColumns: boolean
  rowsMode: 'all' | 'filter' | 'selected'
  rowsStatus: RowsStatus
  runIf: string
  spendLimitUsd: number | null
  fresh: boolean
}

const I = (key: string, label: string) => ({ key, label })
const NAMES = [I('first_name', 'First name'), I('last_name', 'Last name'), I('full_name', 'Full name')]
const COMPANY = [I('domain', 'Company domain'), I('company', 'Company name')]

export interface ResultOption {
  type: ResultType; label: string; hint: string; inputs: Array<{ key: string; label: string }>
}
export const RESULT_OPTIONS: ResultOption[] = [
  { type: 'email', label: 'Work email', hint: 'An address that cleans as one email',
    inputs: [...NAMES, ...COMPANY, I('linkedin_url', 'LinkedIn URL')] },
  { type: 'phone', label: 'Phone', hint: 'A number with its country code',
    inputs: [...NAMES, ...COMPANY, I('linkedin_url', 'LinkedIn URL'), I('email', 'Email')] },
  { type: 'domain', label: 'Company domain', hint: 'Such as acme.com',
    inputs: [I('company', 'Company name'), I('linkedin_url', 'LinkedIn URL'), I('email', 'Email')] },
  { type: 'linkedin_url', label: 'LinkedIn URL', hint: 'A linkedin.com/in or /company page',
    inputs: [...NAMES, ...COMPANY, I('email', 'Email')] },
  { type: 'url', label: 'URL', hint: 'Any web address', inputs: [] },
  { type: 'text', label: 'Text', hint: 'Any short answer', inputs: [] },
]

// Column names that usually hold an input (letters and digits only, lower case).
const SYNONYMS: Record<string, string[]> = {
  first_name: ['firstname', 'first', 'givenname', 'fname'],
  last_name: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  full_name: ['fullname', 'name', 'contactname', 'personname', 'contact'],
  domain: ['domain', 'companydomain', 'website', 'companywebsite', 'url', 'site', 'web', 'websiteurl'],
  company: ['company', 'companyname', 'organization', 'organisation', 'account', 'accountname', 'employer'],
  linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'personlinkedinurl'],
  email: ['email', 'emailaddress', 'workemail', 'businessemail'],
}
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function guessColumn(key: string, columns: string[]): string | null {
  const want = SYNONYMS[key] ?? [squash(key)]
  for (const w of want) {
    const hit = columns.find(c => squash(c) === w)
    if (hit) return hit
  }
  return null
}

export const resultLabel = (t: ResultType) => RESULT_OPTIONS.find(o => o.type === t)?.label ?? t

export function newDraft(type: ResultType, columns: string[]): WaterfallDraft {
  const opt = RESULT_OPTIONS.find(o => o.type === type)!
  const taken = new Set(columns.map(c => c.toLowerCase()))
  let name = opt.label
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${opt.label} ${n}`
  return {
    columnName: name, continueColumn: false, resultType: type, phoneFormat: 'international', phoneCountry: 'US',
    inputs: opt.inputs.map(i => {
      const col = guessColumn(i.key, columns)
      return { ...i, source: col ? { column: col } : null }
    }),
    steps: [], answeredBy: true, hideStepColumns: true, rowsMode: 'all', rowsStatus: 'any', runIf: '',
    spendLimitUsd: null, fresh: false,
  }
}

let nextKey = 1
const keyOf = (id: string | null) => id ?? `new-${nextKey++}`
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

// A step id as the server makes them ("s" + 6 characters).
export function newStepId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `s${Array.from(bytes, b => ID_CHARS[b % ID_CHARS.length]).join('')}`
}

export function emptyChoices(kind: StepKind, toolId = ''): StepChoices {
  if (kind === 'enrichment') {
    return {
      kind, toolId, inputs: {}, providerOrder: [], skipProviders: [], stopAtFirst: false, valuePath: null,
      maxCostUsd: null,
    }
  }
  if (kind === 'ai') return { kind, prompt: '', model: null, webSearch: false }
  if (kind === 'formula') return { kind, formula: '' }
  return { kind, method: 'GET', url: '', headers: {}, body: null, valuePath: '$.', retries: null }
}

export function newStep(choices: StepChoices, toolName?: string): DraftStep {
  const id = newStepId()
  return { key: id, id, label: '', on: true, requires: null, choices, check: null, ...(toolName ? { toolName } : {}) }
}

export function moveStep(steps: DraftStep[], from: number, to: number): DraftStep[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return steps
  const out = [...steps]
  const [s] = out.splice(from, 1)
  out.splice(to, 0, s)
  return out
}

export function fromSetup(s: WaterfallSetup): WaterfallDraft {
  const i = s.input
  return {
    columnName: i.columnName, continueColumn: true, resultType: i.resultType,
    phoneFormat: i.phone?.format ?? 'international', phoneCountry: i.phone?.country ?? 'US',
    inputs: i.inputs.map(x => ({ ...x })),
    steps: i.steps.map(st => ({
      key: keyOf(st.id), id: st.id, label: st.label ?? '', on: st.on, requires: st.requires, choices: st.choices,
      check: st.check ?? null,
      ...(st.id && s.toolNames?.[st.id] ? { toolName: s.toolNames[st.id] } : {}),
    })),
    answeredBy: i.answeredBy, hideStepColumns: i.hideStepColumns, rowsMode: 'all', rowsStatus: 'not_enriched',
    runIf: i.runIf ?? '', spendLimitUsd: null, fresh: i.fresh,
  }
}

// Alternatives left empty while editing are dropped; none left: the default.
function requiresOf(r: string[][] | null): string[][] | null {
  const alts = (r ?? []).filter(a => a.length > 0)
  return alts.length ? alts : null
}

export interface RunChoice {
  test: number | null; rowIndexes: number[] | null; rowGeneration: number | null
  dry?: { only: string | null }   // a dry run (of one step when only is set)
}

export function toInput(d: WaterfallDraft, run: RunChoice): WaterfallRunInput {
  const selected = d.rowsMode === 'selected' && !!run.rowIndexes?.length
  return {
    columnName: d.columnName.trim(), continueColumn: d.continueColumn, resultType: d.resultType,
    phone: d.resultType === 'phone' ? { format: d.phoneFormat, country: d.phoneCountry } : null,
    inputs: d.inputs.map(i => ({ key: i.key, label: i.label, source: i.source })),
    steps: d.steps.map(s => ({
      id: s.id, label: s.label.trim() || null, on: s.on, requires: requiresOf(s.requires), choices: s.choices,
      check: s.check,
    })),
    answeredBy: d.answeredBy, hideStepColumns: d.hideStepColumns,
    rows: {
      mode: selected ? 'selected' : d.rowsMode === 'filter' ? 'filter' : 'all',
      status: d.continueColumn ? d.rowsStatus : 'any', test: run.test,
      rowIndexes: selected ? run.rowIndexes : null,
    },
    runIf: d.runIf.trim() || null, spendLimitUsd: d.spendLimitUsd, concurrency: null, fresh: d.fresh,
    rowGeneration: selected ? run.rowGeneration : null,
    ...(run.dry ? { dry: { rowIds: null, only: run.dry.only } } : {}),
  }
}

// What keeps the draft from running, or null.
export function draftProblem(d: WaterfallDraft): string | null {
  if (!d.columnName.trim()) return 'Name the result column.'
  if (d.steps.length === 0) return 'Add a step.'
  if (!d.steps.some(s => s.on)) return 'Switch at least one step on.'
  for (const s of d.steps) {
    const c = s.choices
    if (c.kind === 'enrichment' && !c.toolId) return 'Pick a tool for each enrichment step.'
    if (c.kind === 'ai' && !c.prompt.trim()) return 'Write the prompt of each AI step.'
    if (c.kind === 'http' && (!c.url.trim() || !c.valuePath.trim() || c.valuePath.trim() === '$.')) {
      return 'Give each HTTP step a URL and the path of its value.'
    }
    if (c.kind === 'formula' && !c.formula.trim()) return 'Write the formula of each formula step.'
    if (s.check?.kind === 'formula' && !s.check.formula.trim()) return 'Write the formula of each check.'
    if (s.check?.kind === 'verify' && d.resultType !== 'email') {
      return 'An email check needs the result type Work email.'
    }
  }
  return null
}
