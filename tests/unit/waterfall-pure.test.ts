// Unit test for the pure waterfall pieces: what counts as an answer per result
// type (lib/waterfall/result-type.ts), the input map (inputs.ts), a row's cells
// from its trace (trace.ts), step keys (keys.ts) and the cost per row
// (estimate.ts). server/src is type:commonjs → default-import + destructure under tsx.
import rtMod from '../../server/src/lib/waterfall/result-type'
import inMod from '../../server/src/lib/waterfall/inputs'
import trMod from '../../server/src/lib/waterfall/trace'
import keyMod from '../../server/src/lib/waterfall/keys'
import estMod from '../../server/src/lib/waterfall/estimate'
import cellsMod from '../../server/src/lib/enrich-cells'
import maskMod from '../../server/src/lib/waterfall/agent-mask'
import cfgMod from '../../server/src/lib/waterfall/config'
const { normalizeResult, defaultValuePath, cleanLinkedinUrl } =
  rtMod as typeof import('../../server/src/lib/waterfall/result-type')
const { inputValues, requiresMet, fixedValueProblem, templateColumn } =
  inMod as typeof import('../../server/src/lib/waterfall/inputs')
const { rowCells, traceCostUsd } = trMod as typeof import('../../server/src/lib/waterfall/trace')
const { settingsKey, answerKey, stepReads } = keyMod as typeof import('../../server/src/lib/waterfall/keys')
const { rowEstimate, withHistory } = estMod as typeof import('../../server/src/lib/waterfall/estimate')
const { ENRICH_CELL } = cellsMod as typeof import('../../server/src/lib/enrich-cells')
const { MASKED, maskHttpStep, restoreMaskedStep } =
  maskMod as typeof import('../../server/src/lib/waterfall/agent-mask')
const { tregPart } = cfgMod as typeof import('../../server/src/lib/waterfall/config')
type WaterfallStep = import('../../server/src/lib/waterfall/config').WaterfallStep
type TraceStep = import('../../server/src/lib/waterfall/trace').TraceStep

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(`${label}${JSON.stringify(got) === JSON.stringify(want) ? '' : ` (got ${JSON.stringify(got)})`}`,
    JSON.stringify(got) === JSON.stringify(want))

// --- result types --------------------------------------------------------------
eq('email cleaned', normalizeResult('email', ' Ada@Acme.EXAMPLE.com '), 'ada@acme.example.com')
eq('email: "not found" is no answer', normalizeResult('email', 'not found'), '')
eq('email: two addresses is no answer', normalizeResult('email', 'a@x.com, b@x.com'), '')
eq('email: a marker is no answer', normalizeResult('email', ENRICH_CELL.notFound), '')
eq('email: null is no answer', normalizeResult('email', null), '')
eq('email: an object is no answer', normalizeResult('email', { email: 'a@x.com' }), '')
eq('phone international', normalizeResult('phone', '(415) 555-2671'), '+1 415 555 2671')
eq('phone e164', normalizeResult('phone', '+44 20 7946 0958', { format: 'e164', country: 'US' }), '+442079460958')
eq('phone: words are no answer', normalizeResult('phone', 'call the office'), '')
eq('domain from a URL', normalizeResult('domain', 'https://www.Acme.com/about'), 'acme.com')
eq('linkedin profile', cleanLinkedinUrl('linkedin.com/in/ada-l/?trk=x'), 'https://www.linkedin.com/in/ada-l')
eq('linkedin company', normalizeResult('linkedin_url', 'https://uk.linkedin.com/company/acme'),
  'https://www.linkedin.com/company/acme')
eq('linkedin: another site is no answer', normalizeResult('linkedin_url', 'https://x.com/in/ada'), '')
eq('url', normalizeResult('url', 'acme.com/pricing'), 'https://acme.com/pricing')
eq('url: localhost is no answer', normalizeResult('url', 'http://localhost/x'), '')
eq('text kept', normalizeResult('text', '  Head of Sales '), 'Head of Sales')
eq('text: N/A is no answer', normalizeResult('text', 'N/A'), '')
eq('text: a number', normalizeResult('text', 42), '42')
eq('default path email', defaultValuePath('email', [{ field: 'confidence', path: '$.output.confidence' },
  { field: 'email', path: '$.output.email' }]), '$.output.email')
eq('default path from a dotted example field',
  defaultValuePath('email', [{ field: 'data.email', path: '$.data.email' }]), '$.data.email')
eq('default path: none fits', defaultValuePath('phone', [{ field: 'email', path: '$.output.email' }]), null)

// --- inputs --------------------------------------------------------------------
const map = { first_name: '{{First Name}}', domain: '{{Website}}', country: 'US', gone: '{{Old}}' }
const row = { 'First Name': '  Ada ', Website: ENRICH_CELL.notFound, Old: 'x' }
const cols = ['First Name', 'Website', 'Old', 'Name}x']
eq('input values', inputValues(map, row, ['Old'], ['first_name', 'domain', 'country', 'gone', 'missing'], cols),
  { first_name: 'Ada', domain: '', country: 'US', gone: '', missing: '' })
eq('a renamed column written in its normalized form still reads',
  inputValues({ n: '{{name_x}}' }, { 'Name}x': 'Grace' }, [], ['n'], cols), { n: 'Grace' })
eq('another case reads', inputValues({ n: '{{first name}}' }, row, [], ['n'], cols), { n: 'Ada' })
check('requires: one alternative is enough',
  requiresMet([['first_name', 'domain'], ['first_name']], { first_name: 'Ada', domain: '' }))
check('requires: none complete', !requiresMet([['first_name', 'domain']], { first_name: 'Ada', domain: '' }))
check('requires: none listed', requiresMet([], {}))
check('fixed value with braces refused', fixedValueProblem('a {{b}}') !== null)
check('fixed value with a /word refused', fixedValueProblem('use /domain') !== null)
check('fixed URL accepted', fixedValueProblem('https://acme.com/a') === null)
eq('template column', templateColumn('{{A}}B}}'), 'A}}B')

// --- trace cells ---------------------------------------------------------------
const step = (id: string, label: string, kind: WaterfallStep['choices']['kind'] = 'http'): WaterfallStep => ({
  id, label, on: true, requires: [],
  choices: kind === 'ai' ? { kind: 'ai', prompt: 'Find /first_name at /domain', model: 'm', webSearch: false }
    : { kind: 'http', method: 'GET', url: 'https://api.example.com/find?d={{domain}}',
      headers: { 'X-Name': '{{first_name}}' }, body: null, valuePath: '$.email', retries: null },
  built: kind === 'ai' ? { kind: 'ai', model: 'm', search: null, capUsd: 0.01, lowUsd: 0.001, highUsd: 0.002 }
    : { kind: 'http', retries: null },
})
const steps = [step('sa00001', 'One'), step('sa00002', 'Two'), step('sa00003', 'Three')]
const t = (id: string, label: string, outcome: TraceStep['outcome'], extra: Partial<TraceStep> = {}): TraceStep =>
  ({ id, label, kind: 'http', outcome, cost_usd: 0, ms: 1, ...extra })
let cells = rowCells({ v: 1, answered_by: 'sa00002', steps: [t('sa00001', 'One', 'not_found'),
  t('sa00002', 'Two', 'answered', { value: 'ada@acme.com' })] }, steps)
eq('answered: the value', cells.statusCell, 'ada@acme.com')
eq('answered: by and step cells', cells.answer, { answered_by: 'Two',
  steps: { sa00001: ENRICH_CELL.notFound, sa00002: 'ada@acme.com', sa00003: '' } })
cells = rowCells({ v: 1, answered_by: null, steps: [t('sa00001', 'One', 'error', { detail: 'HTTP 500' }),
  t('sa00002', 'Two', 'not_found')] }, steps)
check('an error and no answer fails the row',
  cells.status === 'failed' && cells.statusCell.startsWith('❌ One: HTTP 500'))
const noAnswer = (a: TraceStep, b: TraceStep) => rowCells({ v: 1, answered_by: null, steps: [a, b] }, steps)
cells = noAnswer(t('sa00001', 'One', 'no_inputs'), t('sa00002', 'Two', 'no_inputs'))
check('no step had inputs: blank, not run yet', cells.statusCell === '' && cells.status === 'completed')
cells = noAnswer(t('sa00001', 'One', 'not_found'), t('sa00002', 'Two', 'budget'))
eq('last step out of budget', cells.statusCell, ENRICH_CELL.budget)
cells = rowCells({ v: 1, answered_by: 'sa00003', steps: [t('sa00001', 'One', 'error', { detail: 'x' }),
  t('sa00003', 'Three', 'answered', { value: 'v' })] }, steps)
check('an answer after an error completes the row', cells.status === 'completed' && cells.statusCell === 'v')
eq('row cost', traceCostUsd({ v: 1, answered_by: null, steps: [t('a', 'A', 'not_found', { cost_usd: 0.0048 }),
  t('b', 'B', 'not_found', { cost_usd: 0.001, check: { outcome: 'failed', cost_usd: 0.0002 } })] }), 0.006)

// --- keys ----------------------------------------------------------------------
const w = { resultType: 'email' as const }
const a = step('sa00001', 'One')
const renamed = { ...a, label: 'Renamed', on: false }
check('label and switch keep the settings key', settingsKey(w, a) === settingsKey(w, renamed))
check('result type changes it', settingsKey(w, a) !== settingsKey({ resultType: 'text' }, a))
eq('http step reads', stepReads(a, ['first_name', 'domain', 'company']).sort(), ['domain', 'first_name'])
eq('ai step reads', stepReads(step('sa00004', 'AI', 'ai'), ['first_name', 'domain', 'company']).sort(),
  ['domain', 'first_name'])
const k = settingsKey(w, a)
check('answer key follows the values read', answerKey(k, ['domain'], { domain: 'a.com', x: '1' })
  === answerKey(k, ['domain'], { domain: 'a.com', x: '2' }))
check('answer key changes with a value read', answerKey(k, ['domain'], { domain: 'a.com' })
  !== answerKey(k, ['domain'], { domain: 'b.com' }))

// --- estimate ------------------------------------------------------------------
const est = rowEstimate([
  { id: 's1', maxUsd: 0.01, expectedUsd: 0.005, answerRate: 0.5, rateFrom: 'treg' },
  { id: 's2', maxUsd: 0.02, expectedUsd: 0.02, answerRate: null, rateFrom: null },
  { id: 's3', maxUsd: 0.004, expectedUsd: 0.004, answerRate: 0.5, rateFrom: 'treg' },
])
eq('max = every cap', est.maxUsd, 0.034)
// 0.005 + 0.5 x 0.02 + 0.5 x 0.004 (s2's unknown rate never stops the waterfall)
eq('average', est.avgUsd, 0.017)
eq('reach', est.steps.map(s => s.reach), [1, 0.5, 0.5])
eq('history replaces the catalog rate', withHistory({ maxUsd: 1, expectedUsd: 1, answerRate: 0.1, rateFrom: 'treg' },
  { reached: 40, answered: 30 }, 20).answerRate, 0.75)
eq('too little history is ignored', withHistory({ maxUsd: 1, expectedUsd: 1, answerRate: 0.1, rateFrom: 'treg' },
  { reached: 5, answered: 5 }, 20).answerRate, 0.1)

// --- HTTP steps as a caller without the secrets scope reads them ------------------
type Http = import('../../server/src/lib/waterfall/config').HttpChoices
const keyed: Http = {
  kind: 'http', method: 'POST', url: 'https://api.example.com/find?api_key=abc123def456ghi789&d={{domain}}',
  headers: { Authorization: 'Bearer live-value-123' }, body: '{"token":"t-1"}', valuePath: '$.email', retries: null,
}
const shown = maskHttpStep(keyed)
eq('masked: the URL key, header values and the body read the mask', shown, {
  url: 'https://api.example.com/find?api_key=…&d={{domain}}', headers: { Authorization: '…' }, body: '…',
})
const back = { ...shown, method: 'post', headers: { ...shown.headers } } as Record<string, unknown>
check('sent back with the same id and URL: the stored values return',
  restoreMaskedStep(back, keyed, 'steps[0]') === null
  && back.url === keyed.url && (back.headers as Record<string, string>).Authorization === 'Bearer live-value-123'
  && back.body === keyed.body)
const moved = { ...shown, method: 'POST', url: 'https://elsewhere.example/x', headers: { ...shown.headers } } as
  Record<string, unknown>
check('a masked header never goes to a new URL', restoreMaskedStep(moved, keyed, 'steps[0]') !== null
  && (moved.headers as Record<string, string>).Authorization === MASKED)
const otherMethod = { ...shown, method: 'DELETE', headers: { ...shown.headers } } as Record<string, unknown>
check('a masked header never goes with another method', restoreMaskedStep(otherMethod, keyed, 'steps[0]') !== null)
const otherBody = { ...shown, method: 'POST', body: '{"x":1}', headers: { ...shown.headers } } as
  Record<string, unknown>
check('nor with another body', restoreMaskedStep(otherBody, keyed, 'steps[0]') !== null)
check('a masked value with no stored step is refused',
  restoreMaskedStep({ ...shown, headers: { ...shown.headers } }, null, 'steps[0]') !== null)
const plain = { url: 'https://x.io/a', headers: { Accept: 'application/json' }, body: null }
check('nothing masked: untouched',
  restoreMaskedStep(plain, null, 'steps[0]') === null && plain.url === 'https://x.io/a')

// --- the treg part of a waterfall (today's enrichment limit) ------------------------
const tregStep = (capUsd: number | null, on = true) => ({ on, built: { kind: 'enrichment', capUsd } })
const cfgOf = (steps: unknown[]) => ({ waterfall: { steps } }) as Parameters<typeof tregPart>[0]
eq('no treg step: no daily limit', tregPart(cfgOf([{ on: true, built: { kind: 'http' } }])),
  { any: false, unpriced: false })
eq('a priced treg step', tregPart(cfgOf([tregStep(0.02)])), { any: true, unpriced: false })
eq('an unpriced treg step still counts', tregPart(cfgOf([tregStep(0.02), tregStep(null)])),
  { any: true, unpriced: true })
eq('a step switched off is not counted', tregPart(cfgOf([tregStep(null, false)])), { any: false, unpriced: false })

if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
console.log('\nall waterfall pure checks passed')
