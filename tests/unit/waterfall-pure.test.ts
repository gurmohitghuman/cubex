// Over 200 lines: every pure waterfall rule (result types to checks) checked in one script, a section each.
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
import cfgMod from '../../server/src/lib/waterfall/caps'
import checkMod from '../../server/src/lib/waterfall/input-check'
import stepsMod from '../../server/src/lib/waterfall/input-steps'
import formulasMod from '../../server/src/services/waterfall-formulas'
import tplMod from '../../server/src/lib/waterfall/templates'
import refsMod from '../../server/src/lib/formula/refs'
import fcellsMod from '../../server/src/lib/formula/cells'
import sandboxMod from '../../server/src/lib/formula/sandbox'
import agentMod from '../../server/src/lib/waterfall/agent-args'
import constMod from '../../server/src/lib/constants'
const { normalizeResult, defaultValuePath, cleanLinkedinUrl } =
  rtMod as typeof import('../../server/src/lib/waterfall/result-type')
const { inputValues, requiresMet, fixedValueProblem, templateColumn } =
  inMod as typeof import('../../server/src/lib/waterfall/inputs')
const { rowCells, traceCostUsd } = trMod as typeof import('../../server/src/lib/waterfall/trace')
const { settingsKey, answerKey, stepReads, tallyKey, checkKey } =
  keyMod as typeof import('../../server/src/lib/waterfall/keys')
const { rowEstimate, withHistory, withCheck } = estMod as typeof import('../../server/src/lib/waterfall/estimate')
const { ENRICH_CELL } = cellsMod as typeof import('../../server/src/lib/enrich-cells')
const { MASKED, maskHttpStep, restoreMaskedStep } =
  maskMod as typeof import('../../server/src/lib/waterfall/agent-mask')
const { tregPart, rowCaps } = cfgMod as typeof import('../../server/src/lib/waterfall/caps')
const { parseCheck } = checkMod as typeof import('../../server/src/lib/waterfall/input-check')
const { parseStep } = stepsMod as typeof import('../../server/src/lib/waterfall/input-steps')
const { formulaPasses } = formulasMod as typeof import('../../server/src/services/waterfall-formulas')
const { WATERFALL_TEMPLATES, NAME_GUESS, templateOf } =
  tplMod as typeof import('../../server/src/lib/waterfall/templates')
const { compileFormula } = refsMod as typeof import('../../server/src/lib/formula/refs')
const { formulaRow } = fcellsMod as typeof import('../../server/src/lib/formula/cells')
const { FormulaSandbox } = sandboxMod as typeof import('../../server/src/lib/formula/sandbox')
const { agentWaterfallBody } = agentMod as typeof import('../../server/src/lib/waterfall/agent-args')
const { FORMULA_MAX_CHARS } = constMod as typeof import('../../server/src/lib/constants')
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

// --- formula steps and checks --------------------------------------------------------
eq('a verify check accepts the safest verdicts by default', parseCheck({ kind: 'verify' }, 'Step 1'),
  { ok: { kind: 'verify', accept: 'safest' } })
check('a check of another kind is refused', 'error' in parseCheck({ kind: 'lookup' }, 'Step 1'))
check('a check with a key it doesn\'t know is refused', 'error' in parseCheck({ kind: 'verify', acept: 'wide' }, 'S'))
check('a formula check needs its formula', 'error' in parseCheck({ kind: 'formula', formula: '  ' }, 'Step 1'))
const fStep = parseStep({ choices: { kind: 'formula', formula: ' {{domain}} ' },
  check: { kind: 'formula', formula: '{{value}}' } }, 0)
check('a formula step parses, trimmed, with its check', 'ok' in fStep && fStep.ok.choices.kind === 'formula'
  && fStep.ok.choices.formula === '{{domain}}' && fStep.ok.check?.kind === 'formula')
check('a formula step with a key it doesn\'t know is refused',
  'error' in parseStep({ choices: { kind: 'formula', formula: '1', url: 'x' } }, 0))
const checked = withCheck({ maxUsd: 0.01, expectedUsd: 0.005, answerRate: 0.5, rateFrom: 'treg' },
  { usd: 0.002, preRate: 0.5, found: null })
eq('a check adds its cost: the most in full, on average for the values found', [checked.maxUsd, checked.expectedUsd],
  [0.012, 0.006])
eq('with no history of its own, a checked step counts as never answering', [checked.answerRate, checked.rateFrom],
  [null, null])
const known = withCheck({ maxUsd: 0, expectedUsd: 0, answerRate: 0.3, rateFrom: 'history' },
  { usd: 0.002, preRate: 0.3, found: 0.5 })
eq('with history, its rate stays and the check is paid on the share found', [known.answerRate, known.expectedUsd],
  [0.3, 0.001])
eq('no check: the cost as it was', withCheck(checked, null), checked)
const withVerify = { ...step('sv00001', 'Checked'),
  check: { choices: { kind: 'verify', accept: 'safest' },
    built: { kind: 'verify', capUsd: 0.003, tool: { id: 'treg.people.email.verify' } } } } as unknown as WaterfallStep
eq('a verify check counts in the row\'s treg part', rowCaps([withVerify]), { most: 0.003, treg: 0.003 })
const W = { resultType: 'email' as const }
check('a check changes the tally key, not the answer key',
  tallyKey(W, withVerify) !== settingsKey(W, withVerify) && settingsKey(W, withVerify) === settingsKey(W,
    { ...withVerify, check: null }))
check('a check\'s key changes with the value',
  checkKey(withVerify, 'a@x.io', {}) !== checkKey(withVerify, 'b@x.io', {}))
eq('no check, no key', checkKey({ ...withVerify, check: null }, 'a@x.io', {}), null)
eq('a formula\'s yes and no', ['true', 'yes', 'x', 'false', '0', '', 'null', 'NaN'].map(formulaPasses),
  [true, true, true, false, false, false, false, false])

// Starter waterfalls: each step as a start request sends it, and the name guess on a few rows.
for (const t of WATERFALL_TEMPLATES) {
  check(`template ${t.id}: its steps parse as a start request sends them`,
    t.steps.every((st, i) => 'ok' in parseStep(JSON.parse(JSON.stringify(st)), i)))
  check(`template ${t.id}: every input a step requires is one of its inputs`, t.steps.every(st =>
    (st.requires ?? []).flat().every(k => t.inputs.some(i => i.key === k))))
}
eq('an unknown template is none', templateOf('crm'), undefined)
{
  const none = { rowIndexes: null, generation: null }
  const agent = (a: Record<string, unknown>) => agentWaterfallBody({ sheet_id: 's', column_name: 'Email', ...a },
    null, null, none)
  const out = agent({ template: 'work_email', inputs: { full_name: 'Name', domain: 'Website' }, test_step: 'Name guess',
    dry_run: true })
  const body = 'ok' in out ? out.ok as { resultType: string; inputs: Array<{ key: string; source: unknown }>;
    steps: Array<{ id?: string; label: string | null }>; dry: { only: string } } : null
  eq('agents: a template gives its result type and steps', [body?.resultType, body?.steps.length], ['email', 2])
  eq('agents: their mapping laid over its inputs, the rest unmapped',
    body?.inputs.map(i => [i.key, i.source !== null]), [['first_name', false], ['last_name', false],
      ['full_name', true], ['domain', true], ['company', false], ['linkedin_url', false]])
  check('agents: test_step names a template step without touching the template',
    body?.dry.only === body?.steps[1].id && WATERFALL_TEMPLATES[0].steps[1].id === null)
  const refused = (a: Record<string, unknown>) => ('error' in agent(a) ? (agent(a) as { error: string }).error : '')
  check('agents: a template needs inputs', /full_name/.test(refused({ template: 'work_email' })))
  check('agents: test_step names a template\'s treg step by its label', 'ok' in agent({ template: 'work_email',
    inputs: { full_name: 'Name', domain: 'Website' }, test_step: 'treg email finder', dry_run: true }))
  check('agents: a key the template doesn\'t read is a misspelling',
    /"fullname" isn't one of the work_email template's inputs/.test(refused({ template: 'work_email',
      inputs: { fullname: 'Name', domain: 'Website' } })))
  check('agents: an unknown template, or another result type, is refused',
    /work_email or mobile_phone/.test(refused({ template: 'crm', inputs: {} }))
      && /result_type email/.test(refused({ template: 'work_email', result_type: 'phone', inputs: {} })))
}
{
  const keys = WATERFALL_TEMPLATES[0].inputs.map(i => i.key)
  const sb = await FormulaSandbox.open(compileFormula(NAME_GUESS, keys))
  const guess = (row: Record<string, string>) => {
    const out = sb.runRows([formulaRow(sb.compiled.inputs.map(k => row[k] ?? ''))], 1_000).outcomes[0]
    return out.ok ? out.value : `ERR ${out.error}`
  }
  try {
    eq('the guess: first.last at the bare domain', guess({ first_name: 'Maya', last_name: 'Chen',
      domain: 'https://www.Stripe.com/about' }), 'maya.chen@stripe.com')
    eq('the guess: a full name, accents dropped', guess({ full_name: ' José  María García ', domain: 'acme.io' }),
      'jose.garcia@acme.io')
    eq('the guess: one name, or no domain, is none', [guess({ full_name: 'Cher', domain: 'x.io' }),
      guess({ full_name: 'Ada Byron' })], ['', ''])
    eq('the guess: titles, suffixes and what follows a comma or bracket go',
      ['Dr. Maya Chen', 'Maya Chen, MBA', 'John Smith Jr.', 'Maya Chen (she/her)', "Mary-Jane O'Brien"]
        .map(n => guess({ full_name: n, domain: 'acme.io' })),
      ['maya.chen@acme.io', 'maya.chen@acme.io', 'john.smith@acme.io', 'maya.chen@acme.io',
        'maryjane.obrien@acme.io'])
    eq('the guess: none when a letter outside a-z is left',
      ['Michał Nowak', 'Hans Strauß', 'Işık Yılmaz', '李 雷'].map(n => guess({ full_name: n, domain: 'acme.io' })),
      ['', '', '', ''])
    eq('the guess: the bare domain of an address or a site with a port', [
      guess({ full_name: 'Ada Byron', domain: 'ada@Analytical.io' }),
      guess({ full_name: 'Ada Byron', domain: 'analytical.io:8080/x?y=1' })],
    ['ada.byron@analytical.io', 'ada.byron@analytical.io'])
    eq('the guess: none at free mail or a shared site, or on a bare word', ['gmail.com', 'maya@gmail.com',
      'https://www.linkedin.com/in/maya', 'acme'].map(d => guess({ full_name: 'Maya Chen', domain: d })),
    ['', '', '', ''])
    eq('the guess: none from a cell that holds JSON', guess({ full_name: '{"a":1}', domain: 'acme.io' }), '')
    check('the guess fits a formula', NAME_GUESS.length <= FORMULA_MAX_CHARS)
  } finally { sb.dispose() }
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
console.log('\nall waterfall pure checks passed')
