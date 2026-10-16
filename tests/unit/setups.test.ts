// Setups (pure, lib/setups/): the order of a chain's steps and its inputs;
// renaming columns all through a setup in one pass (a swap can't collide, a
// saved key's token is left alone, each reference by its own run's rule);
// reading a setup file (shape, order, every reference accounted for, extra
// fields dropped).
import graphMod from '../../server/src/lib/setups/graph'
import remapMod from '../../server/src/lib/setups/remap'
import checkMod from '../../server/src/lib/setups/check'
import specMod from '../../server/src/lib/setups/spec'
import type { SetupSpec, SetupStep } from '../../server/src/lib/setups/spec'
const { orderSteps } = graphMod as typeof import('../../server/src/lib/setups/graph')
const { remapSpec, stepRenames } = remapMod as typeof import('../../server/src/lib/setups/remap')
const { readSpec, specProblem } = checkMod as typeof import('../../server/src/lib/setups/check')
const { stepColumns } = specMod as typeof import('../../server/src/lib/setups/spec')
import typedMod from '../../server/src/lib/setups/typed-key'
import refsMod from '../../server/src/lib/setups/refs'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

// ---- order ----
{
  const out = orderSteps([
    { label: 'c', makes: ['C'], reads: ['B', 'Name'] },
    { label: 'a', makes: ['A'], reads: ['Website'] },
    { label: 'b', makes: ['B', 'B2'], reads: ['A'] },
  ])
  check('a chain is ordered by what each step reads', 'ok' in out && out.ok.order.join() === '1,2,0', out)
  check('layers count the steps before', 'ok' in out && out.ok.layers.join() === '2,0,1', out)
  check('inputs are what no step makes, first seen first',
    'ok' in out && out.ok.inputs.join() === 'Name,Website', out)
  const loop = orderSteps([{ label: 'x', makes: ['X'], reads: ['Y'] }, { label: 'y', makes: ['Y'], reads: ['X'] }])
  check('a loop is refused, naming its steps', 'problem' in loop && loop.problem.includes('x, y'), loop)
  const self = orderSteps([{ label: 'x', makes: ['X'], reads: ['X'] }])
  check('a step reading itself is refused', 'problem' in self && self.problem.includes('itself'), self)
  const twice = orderSteps([{ label: 'x', makes: ['Email'], reads: [] }, { label: 'y', makes: ['email'], reads: [] }])
  check('two steps making one column (any case) are refused', 'problem' in twice, twice)
}

// ---- a setup to work with ----
const http: SetupStep = {
  kind: 'http', name: 'Lookup',
  request: { method: 'POST', url: 'https://api.example.com/find?d={{Website}}', headers: {
    Authorization: 'Bearer {{apollo_key}}', 'X-Name': '/name',
  }, body: '{"a":"{{Name}}","b":"{{Website}}"}', timeout: null },
  mappings: [{ jsonPath: '$', columnName: 'Response' }], batchSize: null, runIf: '{{Website}} is not empty',
  autoRun: { runIf: '{{Name}} is not empty', dailyCapUsd: null, dailyRowCap: 100 },
}
const formula: SetupStep = {
  kind: 'formula', name: 'Pair', formula: '`${{{Name}}}/${{{Website}}}` + "{{not a ref}}"', description: null,
  autoRun: true,
}
const ai: SetupStep = {
  kind: 'ai', name: 'Score', prompt: 'Rate /name at /website from /response and /pair.', systemPrompt: null,
  model: 'm/x', temperature: 0.7, maxChars: null, concurrency: null, webSearch: true, webFetch: false,
  search: { engine: 'auto', mode: null, maxPerRow: null }, outputColumns: null, runIf: '{{Pair}} is not empty',
}
const clean: SetupStep = { kind: 'clean', name: 'Score clean', source: 'Score (Output)', cleaner: 'trim', options: {},
  autoRun: true }
const spec: SetupSpec = { v: 1, inputs: ['Name', 'Website'], keys: ['apollo_key'], steps: [http, formula, ai, clean] }

check('a well-made setup has no problem', specProblem(spec) === null, specProblem(spec))
check('an AI step with web search makes Output and Data', stepColumns(ai).join() === 'Score (Output),Score (Data)')

// ---- remap ----
{
  const swapped = remapSpec(spec, new Map([['Name', 'Website'], ['Website', 'Name']]))
  const h = swapped.steps[0] as Extract<SetupStep, { kind: 'http' }>
  check('a swap renames each reference once (url and body)',
    h.request.url.endsWith('d={{Name}}') && h.request.body === '{"a":"{{Website}}","b":"{{Name}}"}', h.request)
  check('a saved key token is left alone', h.request.headers.Authorization === 'Bearer {{apollo_key}}',
    h.request.headers)
  check('a /token in a header follows by its normalized name', h.request.headers['X-Name'] === '/website',
    h.request.headers)
  check('rules swap too', h.runIf === '{{Name}} is not empty' && h.autoRun?.runIf === '{{Website}} is not empty', h)
  const f = swapped.steps[1] as Extract<SetupStep, { kind: 'formula' }>
  check('a formula swaps its references and keeps text that names no column',
    f.formula === '`${{{Website}}}/${{{Name}}}` + "{{not a ref}}"', f.formula)
  check('inputs are renamed', swapped.inputs.join() === 'Website,Name', swapped.inputs)
  check('the swapped setup is still consistent', specProblem(swapped) === null, specProblem(swapped))

  const renamed = remapSpec(spec, new Map([['Website', 'Company URL'], ...stepRenames(ai, 'Fit')]))
  const a = renamed.steps[2] as Extract<SetupStep, { kind: 'ai' }>
  check('an AI prompt reads the new input by its normalized name',
    a.prompt === 'Rate /name at /company_url from /response and /pair.', a.prompt)
  check('renaming an AI step renames its base', a.name === 'Fit', a.name)
  const c = renamed.steps[3] as Extract<SetupStep, { kind: 'clean' }>
  check('a step reading the AI column follows its new name', c.source === 'Fit (Output)', c.source)
  check('the renamed setup is still consistent', specProblem(renamed) === null, specProblem(renamed))
}

// ---- reading a file's spec ----
{
  const raw = JSON.parse(JSON.stringify(spec))
  raw.steps[0].extra = 'dropped'
  const out = readSpec(raw)
  check('a good spec reads', 'ok' in out, out)
  check('fields a step does not have are dropped', 'ok' in out && !('extra' in out.ok.steps[0]))
  const outOfOrder = readSpec({ ...raw, steps: [raw.steps[2], raw.steps[0], raw.steps[1], raw.steps[3]] })
  check('steps before what they read are refused', 'problem' in outOfOrder, outOfOrder)
  const missingInput = readSpec({ ...raw, inputs: ['Name'] })
  check('a reference to an unlisted column is refused', 'problem' in missingInput
    && missingInput.problem.includes('Website'), missingInput)
  const missingKey = readSpec({ ...raw, keys: [] })
  check('a request token that is neither a column nor a listed key is refused', 'problem' in missingKey
    && missingKey.problem.includes('apollo_key'), missingKey)
  check('an unknown kind is refused', 'problem' in readSpec({ ...raw, steps: [{ kind: 'shell', name: 'x' }] }))
  check('a wrong type is refused', 'problem' in readSpec({ ...raw, steps: [{ ...raw.steps[0], mappings: 'x' }] }))
  check('an unknown cleaner is refused',
    'problem' in readSpec({ ...raw, steps: [...raw.steps.slice(0, 3), { ...raw.steps[3], cleaner: 'rm' }] }))
  check('not a setup', 'problem' in readSpec({ v: 2 }) && 'problem' in readSpec(null))
}

// ---- review fixes ----
{
  const { typedKeyIn } = typedMod as typeof import('../../server/src/lib/setups/typed-key')
  const { stepReads } = refsMod as typeof import('../../server/src/lib/setups/refs')
  const keys = new Set(['apollo-key'])
  const req = (headers: Record<string, string>, url = 'https://api.example.com/x', body: string | null = null) =>
    ({ method: 'POST' as const, url, headers, body, timeout: null })
  const resolves = (n: string) => n === 'Name' || keys.has(n)
  const bare = { ...http, runIf: null, autoRun: null }
  check('a /name that resolves to nothing is plain text, not a problem', stepReads({ ...bare, request:
    req({}, 'https://api.example.com/x?redirect=/home', '{"path":"/search","n":"{{Name}}"}') } as SetupStep,
  ['Name'], keys).problems.length === 0)
  check('a {{name}} that resolves to nothing is still a problem', stepReads({ ...bare, request:
    req({}, 'https://api.example.com/x', '{{nope}}') } as SetupStep, ['Name'], keys).problems.length === 1)
  check('a saved key read as /name is not a typed key', typedKeyIn(req({ 'X-Api-Key': '/apollo-key',
    Authorization: 'Bearer /apollo-key' }), resolves) === null)
  const literal = ['ab12', 'cd34', 'ef56', 'gh78', 'ij90', 'kl12', 'mn34', 'op56'].join('')
  check('a key typed into a header is found', typedKeyIn(req({ Authorization: `Bearer ${literal}` }), resolves)
    === 'Authorization header')
  check('a user and password in the URL are found',
    typedKeyIn(req({}, 'https://bob:hunter2@api.example.com/x'), resolves) === 'user and password in the URL')
  check('references in the URL\'s user part are fine',
    typedKeyIn(req({}, 'https://{{Name}}:/apollo-key@api.example.com/x'), resolves) === null)

  const fit = remapSpec(spec, new Map([['Score (Output)', 'Lead score']]))
  const fitAi = fit.steps[2] as Extract<SetupStep, { kind: 'ai' }>
  const fitClean = fit.steps[3] as Extract<SetupStep, { kind: 'clean' }>
  check('renaming an AI main column without its suffix renames the base and every reference',
    fitAi.name === 'Lead score' && fitClean.source === 'Lead score (Output)' && specProblem(fit) === null, fit.steps)
  const braces = remapSpec(spec, new Map([['Pair', 'Pa}}ir']]))
  const ai2 = braces.steps[2] as Extract<SetupStep, { kind: 'ai' }>
  check('a rule can\'t take a name with "}}": it stays as it was', ai2.runIf === '{{Pair}} is not empty', ai2.runIf)
  const f2 = remapSpec(spec, new Map([['Website', 'Web}}site']])).steps[1] as Extract<SetupStep, { kind: 'formula' }>
  check('a formula can\'t take a name with "}}": it stays as it was', f2.formula.includes('{{Website}}'), f2.formula)

  const raw = JSON.parse(JSON.stringify(spec))
  raw.steps[0].request.headers = JSON.parse('{"__proto__": "x", "Authorization": "Bearer {{apollo_key}}"}')
  const proto = readSpec(raw)
  const h = 'ok' in proto ? (proto.ok.steps[0] as Extract<SetupStep, { kind: 'http' }>).request.headers : null
  check('a header named __proto__ stays a plain header', !!h && Object.getPrototypeOf(h) === Object.prototype
    && Object.keys(h).includes('__proto__'), proto)
  const nested = JSON.parse(JSON.stringify(spec))
  nested.steps[3].options = { deep: { deeper: {} } }
  check('a cleaner\'s options can\'t nest', 'problem' in readSpec(nested))
  const many = Array.from({ length: 201 }, (_, i) => `c${i}`)
  check('too many inputs are refused', 'problem' in readSpec({ ...JSON.parse(JSON.stringify(spec)), inputs: many }))
  const long = JSON.parse(JSON.stringify(spec))
  long.steps[2].outputColumns = null
  long.steps[2].systemPrompt = 'x'.repeat(250_000)
  check('long text a column allows reads back', 'ok' in readSpec(long))
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall setups checks passed')
