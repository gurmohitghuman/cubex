// Using a setup on a sheet that has some of its columns (pure, lib/setups/again.ts
// through apply-plan.ts): a step whose column is here, made the same way,
// carries it on; a plain column, another kind, other columns made or read, a
// column gone, another enrichment tool, other settings (the same columns read)
// are taken; renaming a step makes it new.
import applyMod from '../../server/src/lib/setups/apply-plan'
import againMod from '../../server/src/lib/setups/again'
import specMod from '../../server/src/lib/setups/spec'
import type { SetupSpec, SetupStep } from '../../server/src/lib/setups/spec'
import type { SheetColumnStep } from '../../server/src/lib/setups/again'
const { planApply } = applyMod as typeof import('../../server/src/lib/setups/apply-plan')
const { fitToSheet } = againMod as typeof import('../../server/src/lib/setups/again')
const { stepColumns } = specMod as typeof import('../../server/src/lib/setups/spec')

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const http: SetupStep = {
  kind: 'http', name: 'Lookup',
  request: { method: 'GET', url: 'https://api.example.com/find?d={{Website}}', headers: {}, body: null,
    timeout: null },
  mappings: [{ jsonPath: '$.id', columnName: 'Response' }], batchSize: null, runIf: null,
  autoRun: { runIf: '{{Name}} is not empty', dailyCapUsd: null, dailyRowCap: 100 },
}
const formula: SetupStep = { kind: 'formula', name: 'Pair', formula: '{{Name}} + {{Response}}', description: null,
  autoRun: true }
const ai: SetupStep = {
  kind: 'ai', name: 'Score', prompt: 'Rate /pair.', systemPrompt: null, model: 'm/x', temperature: 0.7,
  maxChars: null, concurrency: null, webSearch: true, webFetch: false,
  search: { engine: 'auto', mode: null, maxPerRow: null }, outputColumns: null, runIf: null,
}
const spec: SetupSpec = { v: 1, inputs: ['Name', 'Website'], keys: [], steps: [http, formula, ai] }
const inputs = { inputs: { Website: 'Site' } }
const base = ['Name', 'Site']

// The sheet's columns as setup-steps.ts reads them: each step as made here (its auto-run off).
const made = (s: SetupStep, over: Partial<SetupStep> = {}): SheetColumnStep => {
  const step = { ...s, ...over, ...(s.kind === 'http' ? { autoRun: null } : {}) } as SetupStep
  return { kind: step.kind, columns: stepColumns(step), step }
}
const fitted = (() => {
  const p = planApply(spec, base, inputs)
  if (!('ok' in p)) throw new Error(JSON.stringify(p))
  return p.ok.spec
})()
const [fHttp, fFormula, fAi] = fitted.steps
const all = [...base, ...fitted.steps.flatMap(stepColumns)]

{
  const out = planApply(spec, all, inputs, fitted.steps.map(s => made(s)))
  check('every column made the same way carries on (auto-run aside)', 'ok' in out
    && out.ok.modes.join() === 'again,again,again', out)
  const some = planApply(spec, [...base, 'Lookup', 'Response'], inputs, [made(fHttp)])
  check('the rest are new', 'ok' in some && some.ok.modes.join() === 'again,new,new', some)
  const noData = planApply(spec, all.filter(c => c !== 'Score (Data)'), inputs, fitted.steps.map(s => made(s)))
  check('an AI step\'s (Data) column may be gone: its rerun makes it again', 'ok' in noData
    && noData.ok.modes[2] === 'again', noData)
}

{
  const plain = planApply(spec, [...base, 'Lookup'], inputs, [])
  check('a plain column of the name is taken', 'problem' in plain && plain.taken?.join() === 'Lookup', plain)
  const kind = planApply(spec, [...base, 'Lookup'], inputs, [{ kind: 'formula', columns: ['Lookup'],
    step: { kind: 'formula', name: 'Lookup', formula: '1', description: null, autoRun: false } }])
  check('another kind of column is taken, saying so', 'problem' in kind
    && kind.problem.includes('is a Formula column'), kind)
  const reads = planApply(spec, all, inputs,
    fitted.steps.map(s => (s === fAi ? made(s, { prompt: 'Rate /name.' } as Partial<SetupStep>) : made(s))))
  check('a column reading other columns is taken', 'problem' in reads && reads.taken?.includes('Score (Output)')
    && reads.problem.includes('reads other columns'), reads)
  const twoOutputs = {
    mappings: [{ jsonPath: '$.id', columnName: 'Response' }, { jsonPath: '$.x', columnName: 'Other' }],
  }
  const outputs = planApply(spec, [...all, 'Other'], inputs,
    fitted.steps.map(s => (s === fHttp ? made(s, twoOutputs as Partial<SetupStep>) : made(s))))
  check('a column making other columns is taken', 'problem' in outputs
    && outputs.problem.includes('makes other columns'), outputs)
  const otherApi = { request: { ...(fHttp as Extract<SetupStep, { kind: 'http' }>).request,
    url: 'https://other.example.com/find?d={{Site}}' } }
  const api = planApply(spec, all, inputs,
    fitted.steps.map(s => (s === fHttp ? made(s, otherApi as Partial<SetupStep>) : made(s))))
  check('a column calling another API (the same columns read) is taken', 'problem' in api
    && api.problem.includes('"Lookup" here is set up differently from this setup (its request)'), api)
  const reworded = { prompt: 'Score /pair from 1 to 5.' } as Partial<SetupStep>
  const prompt = planApply(spec, all, inputs, fitted.steps.map(s => (s === fAi ? made(s, reworded) : made(s))))
  check('an AI column with another prompt is taken', 'problem' in prompt
    && prompt.problem.includes('(its prompt)'), prompt)
  const tweaks = planApply(spec, all, inputs, fitted.steps.map(s => (s === fAi
    ? made(s, { model: 'other/model', temperature: 0.2, concurrency: 3 } as Partial<SetupStep>) : made(s))))
  check('its model, temperature and concurrency are its own', 'ok' in tweaks
    && tweaks.ok.modes.join() === 'again,again,again', tweaks)
  const gone = planApply(spec, all.filter(c => c !== 'Response'), inputs, fitted.steps.map(s => made(s)))
  check('a column whose output is gone from the sheet is taken', 'problem' in gone
    && gone.problem.includes('isn\'t in this sheet anymore'), gone)
  const renamed = planApply(spec, all, { ...inputs, names: { Lookup: 'Find' } }, fitted.steps.map(s => made(s)))
  check('renaming a step makes it new, and its output still clashes', 'problem' in renamed
    && renamed.taken?.join() === 'Response', renamed)
  const both = planApply(spec, all, { ...inputs, names: { Lookup: 'Find', Response: 'Found' } },
    fitted.steps.map(s => made(s)))
  check('renamed with its output, it is new; the formula reading it then reads other columns', 'problem' in both
    && both.problem.includes('"Pair" here reads other columns'), both)
  void fFormula
}

{
  const enrich = (toolId: string): SetupStep => ({
    kind: 'enrichment', name: 'Email', autoRun: null, toolId, toolName: toolId.toUpperCase(), preset: null,
    inputs: { domain: { column: 'Site' } }, cleanDomains: false, providerOrder: [], skipProviders: [],
    stopAtFirst: true, email: null, outputs: [{ key: 'email', path: '$.output.email', columnName: 'Work email' }],
    conditions: [], runIf: null, maxCostPerRowUsd: null, concurrency: null, fresh: false,
  })
  const s: SetupSpec = { v: 1, inputs: ['Site'], keys: [], steps: [enrich('a')] }
  const cols = ['Site', 'Email', 'Work email']
  const same = fitToSheet(s, cols, [made(enrich('a'))], new Set())
  check('the same enrichment carries on', 'modes' in same && same.modes.join() === 'again', same)
  const other = fitToSheet(s, cols, [made(enrich('b'))], new Set())
  check('another enrichment tool is taken', 'problem' in other && other.problem.includes('another enrichment (B)'),
    other)
  const clean = (cleaner: string): SetupStep => ({ kind: 'clean', name: 'Domain', source: 'Site', cleaner,
    options: {}, autoRun: true })
  const c: SetupSpec = { v: 1, inputs: ['Site'], keys: [], steps: [clean('domain')] }
  check('a clean column with the same cleaner carries on',
    'modes' in fitToSheet(c, ['Site', 'Domain'], [made(clean('domain'))], new Set()))
  const lower = fitToSheet(c, ['Site', 'Domain'], [made(clean('lowercase'))], new Set())
  check('one with another cleaner is taken', 'problem' in lower && lower.problem.includes('(its cleaner)'), lower)
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall setup-again checks passed')
